import { basename } from "node:path";
import {
  type AgentInfo,
  formatAddress,
  type Identity,
  isName,
  MAX_BODY_BYTES,
  type Message,
  parseAddress,
  toName,
} from "@agent-message/protocol";
import { type Api, ApiError, type AttachEvent, type Caller, type Peer, type Session } from "./api.ts";
import { Network } from "./network.ts";
import type { Agent, Store } from "./store.ts";

/** Agents that neither ended nor registered within this window are still listed as peers. */
const LISTED_MS = 7 * 24 * 60 * 60 * 1000;

/** `seenAt` is only rewritten when it is older than this, so routine calls do not touch the disk. */
const SEEN_REFRESH_MS = 10 * 60 * 1000;

/** How long after its last sign of activity a session is still assumed to be mid-turn. */
const BUSY_MS = 10 * 60 * 1000;

/** A live connection to a harness session, through which the session can be woken. */
export type Attachment = {
  /** Process id of the harness, used to recognise hooks that run under the same process. */
  pid: number;
  send(event: AttachEvent): void;
  close(): void;
};

/**
 * The per-device hub: knows the local agents, keeps their inboxes, pushes to attached sessions,
 * and hands messages for other devices to the network.
 */
export class Node {
  /** Who is attached right now. Deliberately not persisted. */
  private readonly attachments = new Map<string, Attachment>();
  /** Until when each agent is assumed to be mid-turn, and so will collect messages by itself. */
  private readonly busyUntil = new Map<string, number>();
  readonly network: Network;

  constructor(
    private readonly store: Store,
    identity: Identity,
    private readonly now: () => number = Date.now,
  ) {
    this.network = new Network(
      store,
      identity,
      { receive: (message) => this.receive(message), agents: () => this.agentInfos() },
      now,
    );
  }

  get device(): string {
    return this.network.device.name;
  }

  /**
   * Records that a harness session exists and returns its agent. A session keeps its name for life;
   * a new session may ask for a name, taking it over unless a live session holds it.
   */
  register({ harness, session, cwd, name, ancestors }: Session & { ancestors?: number[] }): Agent {
    let agent = this.store.agentBySession(harness, session);
    // A hook running under a harness process that already has a channel: the process moved to this session.
    const channel = [...this.attachments].find(([, attachment]) => ancestors?.includes(attachment.pid));
    if (channel && channel[0] !== agent?.name) {
      const [previous, attachment] = channel;
      this.attachments.delete(previous);
      if (agent) this.store.deleteAgentIfUnused(previous);
      else agent = this.store.agent(previous);
      if (agent) this.attachments.set(agent.name, attachment);
      this.busyUntil.delete(previous);
    }

    const now = this.now();
    const next: Agent = {
      name: agent?.name ?? this.pickName(harness, session, cwd, name),
      harness,
      session,
      cwd,
      open: true,
      seenAt: now,
    };
    const changed = !agent || agent.session !== session || agent.cwd !== cwd || !agent.open;
    if (changed || now - agent!.seenAt > SEEN_REFRESH_MS) this.store.saveAgent(next);
    if (changed) this.network.announce();
    return next;
  }

  /** Marks a session as ended. A session with a live channel is left alone: the process is evidently still there. */
  end(harness: string, session: string): void {
    const agent = this.store.agentBySession(harness, session);
    if (!agent || this.attachments.has(agent.name)) return;
    if (!this.store.deleteAgentIfUnused(agent.name)) this.store.saveAgent({ ...agent, open: false });
    this.network.announce();
  }

  /** Connects a wake-up channel to a session, replacing any earlier one. Returns the agent and a function that detaches. */
  attach(session: Session, attachment: Attachment): { agent: Agent; detach: () => void } {
    const agent = this.register(session);
    const previous = this.attachments.get(agent.name);
    previous?.send({ type: "superseded" });
    previous?.close();
    this.attachments.set(agent.name, attachment);
    attachment.send({ type: "attached", address: formatAddress(agent.name, this.device) });
    this.wake(agent.name);
    this.network.announce();
    return {
      agent,
      detach: () => {
        // Look the attachment up by identity: the agent may have been renamed or superseded meanwhile.
        for (const [name, current] of this.attachments) {
          if (current !== attachment) continue;
          this.attachments.delete(name);
          this.network.announce();
        }
      },
    };
  }

  whoami(caller: Caller): Api["whoami"]["result"] {
    return { address: formatAddress(this.resolve(caller).name, this.device) };
  }

  async send(caller: Caller, to: string, body: string, replyTo?: string): Promise<Api["send"]["result"]> {
    const sender = this.resolve(caller);
    if (!body.trim()) throw new ApiError("empty_body", "Message body is empty");
    if (Buffer.byteLength(body) > MAX_BODY_BYTES)
      throw new ApiError("body_too_large", `Message body exceeds ${MAX_BODY_BYTES} bytes`);
    const { agent, device = this.device } = address(to);
    const message: Message = {
      id: crypto.randomUUID(),
      from: formatAddress(sender.name, this.device),
      to: formatAddress(agent, device),
      body,
      ...(replyTo ? { replyTo } : {}),
      sentAt: this.now(),
    };

    if (device !== this.device) {
      await this.network.send(device, agent, message);
      return { id: message.id, to: message.to, recipient: "remote" };
    }
    if (agent === sender.name) throw new ApiError("self_send", "An agent cannot message itself");
    const recipient = this.store.agent(agent);
    if (!recipient) {
      throw new ApiError(
        "unknown_agent",
        `No agent named "${agent}" on this device. Run \`agent-message peers\` to see who is reachable.`,
      );
    }
    if (!recipient.open)
      throw new ApiError(
        "agent_ended",
        `The session of "${agent}" has ended. Run \`agent-message peers\` to see who is reachable.`,
      );
    this.store.addMessage(agent, message);
    this.wake(agent);
    return { id: message.id, to: message.to, recipient: this.attachments.has(agent) ? "live" : "idle" };
  }

  /**
   * Hands the caller its waiting messages. Delivery always happens this way, by the session asking,
   * so a message is never marked delivered on the strength of a push that the harness may have dropped.
   */
  take(caller: Caller, turn?: "active" | "ending"): Message[] {
    const { name } = this.resolve(caller);
    const messages = this.store.takeMessages(name, this.now());
    // A session that is ending its turn with nothing to read goes idle; one that got messages carries on.
    if (turn === "active" || (turn === "ending" && messages.length)) this.busyUntil.set(name, this.now() + BUSY_MS);
    else if (turn === "ending") this.busyUntil.delete(name);
    return messages;
  }

  peers(): Api["peers"]["result"] {
    const local = this.agentInfos().map(
      (info): Peer => ({ ...info, address: formatAddress(info.name, this.device), device: this.device }),
    );
    return { device: this.device, peers: [...local, ...this.network.peers()] };
  }

  /** Drops expired messages and forgotten agents. */
  prune(): void {
    this.store.prune(this.now(), new Set(this.attachments.keys()));
  }

  close(): void {
    for (const attachment of this.attachments.values()) attachment.close();
    this.attachments.clear();
    this.network.close();
  }

  /** A message from another device arrived for a local agent. */
  private receive(message: Message): void {
    const { agent } = parseAddress(message.to);
    if (!this.store.agent(agent)) return;
    if (this.store.addMessage(agent, message)) this.wake(agent);
  }

  /** Prompts an attached, idle session to collect its messages. A busy one picks them up through its hooks. */
  private wake(name: string): void {
    const pending = this.store.pendingCount(name);
    if (pending && this.now() >= (this.busyUntil.get(name) ?? 0))
      this.attachments.get(name)?.send({ type: "wake", pending });
  }

  private resolve(caller: Caller): Agent {
    if (caller.as) {
      if (!isName(caller.as)) throw new ApiError("invalid_name", `Invalid agent name: ${caller.as}`);
      return (
        this.store.agent(caller.as) ??
        this.register({ harness: "cli", session: caller.as, cwd: caller.cwd ?? "", name: caller.as })
      );
    }
    if (caller.harness && caller.session) {
      // The caller's directory may differ from the session's, so an agent that is already known is left as it is.
      const agent = this.store.agentBySession(caller.harness, caller.session);
      return agent?.open
        ? agent
        : this.register({ harness: caller.harness, session: caller.session, cwd: agent?.cwd ?? caller.cwd ?? "" });
    }
    throw new ApiError(
      "unknown_caller",
      "Cannot tell which agent is calling. Run this inside an agent session, or pass --as <name>.",
    );
  }

  private pickName(harness: string, session: string, cwd: string, requested?: string): string {
    if (requested !== undefined) {
      if (!isName(requested)) throw new ApiError("invalid_name", `Invalid agent name: ${requested}`);
      if (this.attachments.has(requested))
        throw new ApiError("name_taken", `The name "${requested}" belongs to a live session`);
      return requested;
    }
    const base = (toName(basename(cwd)) || harness).slice(0, 40);
    const id = session.toLowerCase().replace(/[^a-z0-9]/g, "");
    for (let length = Math.min(4, id.length); length > 0 && length <= id.length; length++) {
      const name = `${base}-${id.slice(0, length)}`;
      if (!this.store.agent(name)) return name;
    }
    return `${base}-${crypto.randomUUID().slice(0, 8)}`;
  }

  private agentInfos(): AgentInfo[] {
    const cutoff = this.now() - LISTED_MS;
    return this.store
      .agents()
      .filter((agent) => this.attachments.has(agent.name) || (agent.open && agent.seenAt > cutoff))
      .map(({ name, harness, cwd }) => ({ name, harness, cwd, online: this.attachments.has(name) }));
  }
}

function address(text: string) {
  try {
    return parseAddress(text);
  } catch {
    throw new ApiError("invalid_address", `Invalid address "${text}". Use <agent> or <agent>@<device>.`);
  }
}
