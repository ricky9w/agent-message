import {
  type AgentInfo,
  applyEntry,
  createEntry,
  type Device,
  deviceId,
  type Envelope,
  findDevice,
  formatAddress,
  type Identity,
  isName,
  MESSAGE_TTL_MS,
  type Message,
  normalizePairingCode,
  openEnvelope,
  PAIRING_TTL_MS,
  type Payload,
  pairingCode,
  parseAddress,
  type RelayFrame,
  type Roster,
  type RosterEntry,
  type RosterResponse,
  sealEnvelope,
  signRequest,
  verifyRoster,
} from "@agent-message/protocol";
import { ApiError, type NetworkStatus, type Peer } from "./api.ts";
import { saveIdentity } from "./identity.ts";
import { RelayLink, Stop } from "./link.ts";
import { log } from "./log.ts";
import { identityPath } from "./paths.ts";
import type { Store } from "./store.ts";

const JOIN_POLL_MS = 3000;

export type NetworkHandlers = {
  /** A message from another device was decrypted and verified. */
  receive(message: Message): void;
  /** The agents this device currently offers to its peers. */
  agents(): AgentInfo[];
};

/**
 * This device's membership in a network of devices: the roster, the relay connection, pairing,
 * and the encrypted exchange of messages and agent lists with the other members.
 * Without a relay configured it does nothing, and the node works for local agents only.
 */
export class Network {
  private roster?: Roster;
  private relay?: URL;
  private link?: RelayLink;
  private joining?: { relay: URL; network: string; timer: Timer };
  private stopReason?: string;
  /** Ids of the other devices connected to the relay right now. */
  private readonly online = new Set<string>();
  /** The latest agent list each device sent. */
  private readonly directory = new Map<string, { agents: AgentInfo[]; at: number }>();

  constructor(
    private readonly store: Store,
    private identity: Identity,
    private readonly handlers: NetworkHandlers,
    private readonly now: () => number,
  ) {}

  get device(): Device {
    return this.identity.device;
  }

  /** Restores membership from disk and connects. */
  async start(): Promise<void> {
    const relay = this.store.get("relay");
    const entries = this.store.roster();
    if (!relay || !entries.length) return;
    this.roster = await verifyRoster(entries);
    this.relay = new URL(relay);
    this.connect();
  }

  close(): void {
    this.link?.close();
    clearInterval(this.joining?.timer);
  }

  status(): NetworkStatus {
    if (this.joining) return { state: "joining", relay: this.joining.relay.href, code: pairingCode(this.device.id) };
    if (!this.roster || !this.relay) return { state: "none" };
    if (this.stopReason) return { state: "stopped", relay: this.relay.href, reason: this.stopReason };
    return {
      state: "joined",
      relay: this.relay.href,
      network: this.roster.network,
      connected: this.link?.connected ?? false,
      connecting: this.link?.connecting ?? false,
      pending: this.store.outbox().length,
      devices: [...this.roster.devices.values()].map(({ id, name }) => ({
        id,
        name,
        self: id === this.device.id,
        online: id === this.device.id ? (this.link?.connected ?? false) : this.online.has(id),
      })),
    };
  }

  /** Founds a network on a freshly deployed relay, with this device as its first member. */
  async init(relay: string, token: string, deviceName?: string): Promise<void> {
    this.requireUnjoined();
    this.rename(deviceName);
    const url = relayUrl(relay);
    const entry = await createEntry(undefined, "add", this.device, this.identity, this.now());
    await this.request(url, "POST", "/v1/init", { entry }, `Bearer ${token}`);
    this.adopt(url, await applyEntry(undefined, entry), [entry]);
  }

  /** Asks to join the network `network` on `relay`, then waits for a member to approve the pairing code. */
  async join(relay: string, network: string, deviceName?: string): Promise<void> {
    this.requireUnjoined();
    this.rename(deviceName);
    const url = relayUrl(relay);
    await this.request(url, "POST", "/v1/pair", { device: this.device });
    const deadline = this.now() + PAIRING_TTL_MS;
    const timer = setInterval(() => void this.pollJoin(deadline), JOIN_POLL_MS);
    this.joining = { relay: url, network, timer };
  }

  /** Admits the device that is showing `code`. */
  async approve(code: string): Promise<string> {
    const { relay } = this.requireJoined();
    const prefix = normalizePairingCode(code);
    const { device } = (await this.request(relay, "GET", `/v1/pair/${prefix}`)) as { device: Device };
    // The relay is not trusted to say whose keys these are: the code the user typed must match them.
    if (!device.id.startsWith(prefix) || device.id !== (await deviceId(device.signKey, device.kexKey))) {
      throw new ApiError("pairing_mismatch", "The relay returned a device that does not match this code");
    }
    await this.append("add", device);
    return device.name;
  }

  async revoke(name: string): Promise<void> {
    const { roster } = this.requireJoined();
    const device = findDevice(roster, name);
    if (!device) throw new ApiError("unknown_device", `No device named "${name}" in this network`);
    if (device.id === this.device.id)
      throw new ApiError("self_revoke", "Use `agent-message relay leave` to remove this device");
    await this.append("revoke", { id: device.id });
  }

  /** Removes this device from the network if the relay is reachable, and forgets the network either way. */
  async leave(): Promise<void> {
    if (this.roster?.devices.has(this.device.id) && !this.stopReason) {
      await this.append("revoke", { id: this.device.id }).catch((error) => log("could not announce leaving", error));
    }
    this.close();
    this.link = this.roster = this.relay = this.joining = this.stopReason = undefined;
    this.online.clear();
    this.directory.clear();
    this.store.clearNetwork();
  }

  /** Encrypts a message for the device named `deviceName` and queues it for the relay. */
  async send(deviceName: string, agent: string, message: Message): Promise<void> {
    const { roster } = this.requireJoined();
    const device = findDevice(roster, deviceName);
    if (!device)
      throw new ApiError(
        "unknown_device",
        `No device named "${deviceName}" in this network. Run \`agent-message peers\`.`,
      );
    const known = this.directory.get(device.id);
    if (known && !known.agents.some((info) => info.name === agent)) {
      throw new ApiError(
        "unknown_agent",
        `No agent named "${agent}" on ${deviceName}. Run \`agent-message peers\` to see who is reachable.`,
      );
    }
    const envelope = await this.seal({ type: "message", message }, device, {
      expires: message.sentAt + MESSAGE_TTL_MS,
    });
    this.store.addOutbox(envelope);
    this.link?.send({ t: "send", envelope });
  }

  /** Tells the connected devices which agents live here. Call whenever that changes. */
  announce(): void {
    for (const id of this.online) void this.announceTo(id);
  }

  /** Agents on other devices, as last reported by those devices. */
  peers(): Peer[] {
    return [...this.directory].flatMap(([id, { agents }]) => {
      const device = this.roster?.devices.get(id);
      if (!device) return [];
      return agents.map((info) => ({
        ...info,
        online: info.online && this.online.has(id),
        address: formatAddress(info.name, device.name),
        device: device.name,
      }));
    });
  }

  private connect(): void {
    this.link = new RelayLink(
      this.relay!,
      this.identity,
      {
        prepare: () => this.sync(),
        frame: (frame) => this.handle(frame),
        disconnected: () => this.online.clear(),
        stopped: (reason) => {
          this.stopReason = reason;
        },
      },
      this.now,
    );
  }

  /** Fetches roster entries this device has not seen. Stops the link if the device is no longer a member. */
  private async sync(): Promise<void> {
    const roster = this.roster!;
    let response: RosterResponse;
    try {
      response = (await this.request(this.relay!, "GET", `/v1/roster?after=${roster.length}`)) as RosterResponse;
    } catch (error) {
      if (error instanceof ApiError && error.code === "relay_403")
        throw new Stop("This device was removed from the network");
      throw error;
    }
    if (!response.entries.length) return;
    this.roster = await verifyRoster(response.entries, roster);
    this.store.appendRoster(response.entries, roster.length);
    for (const id of this.directory.keys()) if (!this.roster.devices.has(id)) this.directory.delete(id);
  }

  private async handle(frame: RelayFrame): Promise<void> {
    switch (frame.t) {
      case "hello":
        if (frame.roster > this.roster!.length) await this.sync();
        this.online.clear();
        for (const id of frame.online) this.online.add(id);
        for (const envelope of this.store.outbox()) this.link?.send({ t: "send", envelope });
        this.announce();
        return;
      case "deliver":
        await this.open(frame.envelope);
        if (!frame.envelope.ephemeral) this.link?.send({ t: "ack", id: frame.envelope.id });
        return;
      case "sent":
        return this.store.removeOutbox(frame.id);
      case "rejected":
        log(`relay rejected envelope ${frame.id}: ${frame.reason}`);
        return this.store.removeOutbox(frame.id);
      case "roster":
        if (frame.roster > this.roster!.length) await this.sync();
        return;
      case "presence":
        if (!frame.online) return void this.online.delete(frame.device);
        this.online.add(frame.device);
        return this.announceTo(frame.device);
    }
  }

  /** Decrypts an incoming envelope and acts on it. Anything that fails verification is dropped. */
  private async open(envelope: Envelope): Promise<void> {
    if (!this.roster!.devices.has(envelope.from)) await this.sync().catch(() => {});
    const sender = this.roster!.devices.get(envelope.from);
    if (!sender) return log(`dropped envelope from unknown device ${envelope.from}`);
    let payload: Payload;
    try {
      payload = await openEnvelope(envelope, this.identity, sender);
    } catch (error) {
      return log(`dropped envelope from ${sender.name}`, error);
    }
    if (payload.type === "agents") {
      if (payload.at > (this.directory.get(sender.id)?.at ?? 0)) this.directory.set(sender.id, payload);
    } else if (payload.type === "message") {
      const { message } = payload;
      // A device may only speak for its own agents, and only to ours.
      const fromSender = parseAddress(message.from).device === sender.name;
      const toSelf = parseAddress(message.to).device === this.device.name;
      if (fromSender && toSelf) this.handlers.receive(message);
      else log(`dropped misaddressed message from ${sender.name}`);
    }
  }

  private async announceTo(id: string): Promise<void> {
    const device = this.roster?.devices.get(id);
    if (!device || !this.link?.connected) return;
    const now = this.now();
    const payload: Payload = { type: "agents", agents: this.handlers.agents(), at: now };
    this.link.send({
      t: "send",
      envelope: await this.seal(payload, device, { expires: now + 60_000, ephemeral: true }),
    });
  }

  private seal(payload: Payload, to: Device, options: { expires: number; ephemeral?: true }): Promise<Envelope> {
    return sealEnvelope(payload, this.identity, to, { id: crypto.randomUUID(), ...options });
  }

  /** Signs a roster entry, has the relay accept it, and applies it here. */
  private async append(action: RosterEntry["action"], device: RosterEntry["device"]): Promise<void> {
    await this.sync();
    const roster = this.roster!;
    const entry = await createEntry(roster, action, device, this.identity, this.now());
    const next = await applyEntry(roster, entry).catch((error: Error) => {
      throw new ApiError("roster_rejected", error.message);
    });
    await this.request(this.relay!, "POST", "/v1/roster", { entry });
    this.roster = next;
    this.store.appendRoster([entry], roster.length);
  }

  private async pollJoin(deadline: number): Promise<void> {
    const joining = this.joining;
    if (!joining) return;
    const fail = (reason: string) => {
      clearInterval(joining.timer);
      this.joining = undefined;
      log(`joining failed: ${reason}`);
    };
    try {
      const { entries } = (await this.request(joining.relay, "GET", "/v1/roster")) as RosterResponse;
      const roster = await verifyRoster(entries);
      // The relay is not trusted to say which network this is: it must be the one the user named.
      if (roster.network !== joining.network)
        return fail("the relay serves a different network than the one requested");
      if (!roster.devices.has(this.device.id)) return fail("this device is not in the roster");
      clearInterval(joining.timer);
      this.joining = undefined;
      this.adopt(joining.relay, roster, entries);
    } catch (error) {
      if (this.now() > deadline) fail("the pairing code expired before it was approved");
      else if (!(error instanceof ApiError && error.code === "relay_403")) log("waiting for approval", error);
    }
  }

  private adopt(relay: URL, roster: Roster, entries: RosterEntry[]): void {
    this.store.clearNetwork();
    this.store.appendRoster(entries, 0);
    this.store.set("relay", relay.href);
    this.relay = relay;
    this.roster = roster;
    this.stopReason = undefined;
    this.connect();
  }

  private rename(name?: string): void {
    if (name === undefined || name === this.device.name) return;
    if (!isName(name)) throw new ApiError("invalid_name", `Invalid device name: ${name}`);
    this.identity = { ...this.identity, device: { ...this.device, name } };
    saveIdentity(identityPath, this.identity);
  }

  private requireUnjoined(): void {
    if (this.roster || this.joining)
      throw new ApiError(
        "already_joined",
        "This device already belongs to a network. Run `agent-message relay leave` first.",
      );
  }

  private requireJoined(): { roster: Roster; relay: URL } {
    if (!this.roster || !this.relay) {
      throw new ApiError(
        "no_network",
        "This device is not part of a network, so only local agents are reachable. See `agent-message relay --help`.",
      );
    }
    if (this.stopReason)
      throw new ApiError("network_stopped", `${this.stopReason}. Run \`agent-message relay leave\` to reset.`);
    return { roster: this.roster, relay: this.relay };
  }

  /** Calls the relay's HTTP API, signed as this device unless another credential is given. */
  private async request(
    relay: URL,
    method: string,
    path: string,
    body?: unknown,
    authorization?: string,
  ): Promise<unknown> {
    const url = new URL(path, relay);
    const text = body === undefined ? "" : JSON.stringify(body);
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: { authorization: authorization ?? (await signRequest(this.identity, method, url, text, this.now())) },
        ...(body === undefined ? {} : { body: text }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new ApiError(
        "relay_unreachable",
        `Cannot reach the relay at ${relay.origin}: ${error instanceof Error ? error.message : error}`,
      );
    }
    const result = (await response.json().catch(() => ({}))) as { error?: string };
    if (!response.ok) throw new ApiError(`relay_${response.status}`, `Relay: ${result.error ?? response.statusText}`);
    return result;
  }
}

function relayUrl(text: string): URL {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new ApiError("invalid_relay", `Invalid relay URL: ${text}`);
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new ApiError("invalid_relay", "The relay URL must use https");
  }
  return new URL(url.origin);
}
