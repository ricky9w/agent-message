import { DurableObject } from "cloudflare:workers";
import {
  applyEntry,
  CLOSE_REVOKED,
  CLOSE_SUPERSEDED,
  type Device,
  deviceId,
  type Envelope,
  isName,
  MAX_ENVELOPE_BYTES,
  MESSAGE_TTL_MS,
  normalizePairingCode,
  PAIRING_CODE_LENGTH,
  PAIRING_TTL_MS,
  type RelayFrame,
  type Roster,
  type RosterEntry,
  type RosterResponse,
  utf8,
  verifyRequest,
  verifyRoster,
} from "@agent-message/protocol";
import { isEntryRequest, isPairRequest, parseFrame } from "./validate.ts";

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_PENDING_PAIRINGS = 8;
const MAX_QUEUED_ENVELOPES = 10_000;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS roster (idx INTEGER PRIMARY KEY, entry TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS pairing (device_id TEXT PRIMARY KEY, device TEXT NOT NULL, expires INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS queue (
    seq INTEGER PRIMARY KEY,
    sender TEXT NOT NULL,
    recipient TEXT NOT NULL,
    id TEXT NOT NULL,
    envelope TEXT NOT NULL,
    expires INTEGER NOT NULL,
    UNIQUE (sender, id)
  );
  CREATE INDEX IF NOT EXISTS queue_recipient ON queue (recipient, seq);
  CREATE INDEX IF NOT EXISTS queue_expires ON queue (expires);
`;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function fail(status: number, message: string): never {
  throw new HttpError(status, message);
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function readBody(request: Request): Promise<string> {
  const body = await request.text();
  if (utf8(body).byteLength > MAX_REQUEST_BYTES) fail(413, "Request body is too large");
  return body;
}

function parseBody<T>(body: string, isValid: (value: unknown) => value is T): T {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    fail(400, "Request body is not JSON");
  }
  return isValid(value) ? value : fail(400, "Malformed request body");
}

/** Constant-time string comparison; comparing digests hides the length too. */
async function sameSecret(a: string, b: string): Promise<boolean> {
  const digest = (text: string) => crypto.subtle.digest("SHA-256", utf8(text));
  return crypto.subtle.timingSafeEqual(await digest(a), await digest(b));
}

const keysMatch = (device: Device) =>
  deviceId(device.signKey, device.kexKey).then(
    (id) => id === device.id,
    () => false,
  );

/** Stored envelopes are already JSON, so they are spliced into the frame instead of being parsed again. */
const deliverFrame = (envelope: string) => `{"t":"deliver","envelope":${envelope}}`;

/**
 * The relay for one network: authenticates devices against the signed roster and stores and forwards
 * envelopes it cannot read. The object may be evicted between any two events, so everything it needs
 * lives in SQLite or on the hibernatable sockets, which are tagged with their device id.
 */
export class Relay extends DurableObject<Env> {
  readonly #sql = this.ctx.storage.sql;
  /** Cache of the verified roster; undefined until loaded or while the network is not initialized. */
  #roster: Roster | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#sql.exec(SCHEMA);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      switch (`${request.method} ${url.pathname.replace(/^\/v1\/pair\/[^/]+$/, "/v1/pair/:code")}`) {
        case "GET /v1":
          return Response.json({ protocol: 1, network: (await this.#loadRoster())?.network ?? null });
        case "POST /v1/init":
          return await this.#init(request);
        case "POST /v1/pair":
          return await this.#pair(request, url);
        case "GET /v1/pair/:code":
          return await this.#findPairing(request, url);
        case "GET /v1/roster":
          return await this.#getRoster(request, url);
        case "POST /v1/roster":
          return await this.#appendRoster(request, url);
        case "GET /v1/connect":
          return await this.#connect(request, url);
        default:
          return fail(404, "Not found");
      }
    } catch (error) {
      if (error instanceof HttpError) return Response.json({ error: error.message }, { status: error.status });
      throw error;
    }
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const frame = typeof message === "string" ? parseFrame(message) : undefined;
    if (!frame) return ws.close(1003, "Malformed frame");
    const device = this.#deviceOf(ws);
    if (frame.t === "ack") {
      this.#sql.exec("DELETE FROM queue WHERE recipient = ? AND id = ?", device, frame.id);
      return;
    }
    const { id } = frame.envelope;
    const reason = await this.#route(device, frame.envelope);
    this.#send(ws, reason ? { t: "rejected", id, reason } : { t: "sent", id });
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const device = this.#deviceOf(ws);
    // A superseded socket's device is still online, and a revoked device's peers learn of it from the roster.
    if (this.#sockets(device).length || !(await this.#loadRoster())?.devices.has(device)) return;
    this.#broadcast({ t: "presence", device, online: false });
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    this.#sql.exec("DELETE FROM queue WHERE expires <= ?", now);
    this.#sql.exec("DELETE FROM pairing WHERE expires <= ?", now);
    await this.#scheduleAlarm();
  }

  async #init(request: Request): Promise<Response> {
    const token = this.env.BOOTSTRAP_TOKEN;
    if (!token) fail(503, "Relay has no bootstrap token configured");
    if (!(await sameSecret(request.headers.get("Authorization") ?? "", `Bearer ${token}`))) {
      fail(401, "Invalid bootstrap token");
    }
    const { entry } = parseBody(await readBody(request), isEntryRequest);
    if (await this.#loadRoster()) fail(409, "Network is already initialized");
    const roster = await this.#append(undefined, entry, 400);
    return Response.json({ network: roster.network }, { status: 201 });
  }

  async #pair(request: Request, url: URL): Promise<Response> {
    const body = await readBody(request);
    const { device } = parseBody(body, isPairRequest);
    // Signed by the key it asks to have added, so nobody can queue a request on another device's behalf.
    await verifyRequest(
      request.headers.get("Authorization"),
      request.method,
      url,
      body,
      (id) => (id === device.id ? device.signKey : undefined),
      Date.now(),
    ).catch((error) => fail(401, messageOf(error)));
    if (!isName(device.name) || !(await keysMatch(device))) fail(400, "Invalid device");

    const roster = await this.#loadRoster();
    if (!roster) fail(409, "Network is not initialized");
    if (roster.seen.has(device.id)) fail(409, "Device was already added");

    const now = Date.now();
    const { pending } = this.#sql
      .exec<{ pending: number }>(
        "SELECT count(*) AS pending FROM pairing WHERE expires > ? AND device_id != ?",
        now,
        device.id,
      )
      .one();
    if (pending >= MAX_PENDING_PAIRINGS) fail(429, "Too many pending pairing requests");

    const { id, name, signKey, kexKey } = device;
    this.#sql.exec(
      `INSERT INTO pairing (device_id, device, expires) VALUES (?, ?, ?)
       ON CONFLICT (device_id) DO UPDATE SET device = excluded.device, expires = excluded.expires`,
      id,
      JSON.stringify({ id, name, signKey, kexKey }),
      now + PAIRING_TTL_MS,
    );
    await this.#scheduleAlarm();
    return Response.json({}, { status: 202 });
  }

  async #findPairing(request: Request, url: URL): Promise<Response> {
    await this.#authenticate(request, url);
    const prefix = normalizePairingCode(url.pathname.slice("/v1/pair/".length));
    if (prefix.length !== PAIRING_CODE_LENGTH) fail(400, "Invalid pairing code");
    const [row] = this.#sql
      .exec<{ device: string }>(
        "SELECT device FROM pairing WHERE substr(device_id, 1, ?) = ? AND expires > ?",
        PAIRING_CODE_LENGTH,
        prefix,
        Date.now(),
      )
      .toArray();
    if (!row) fail(404, "No pending pairing request has this code");
    return Response.json({ device: JSON.parse(row.device) });
  }

  async #getRoster(request: Request, url: URL): Promise<Response> {
    await this.#authenticate(request, url);
    const after = Number(url.searchParams.get("after") ?? 0);
    if (!Number.isSafeInteger(after) || after < 0) fail(400, "Invalid roster index");
    const entries = this.#sql
      .exec<{ entry: string }>("SELECT entry FROM roster WHERE idx >= ? ORDER BY idx", after)
      .toArray()
      .map(({ entry }) => JSON.parse(entry) as RosterEntry);
    return Response.json({ entries } satisfies RosterResponse);
  }

  async #appendRoster(request: Request, url: URL): Promise<Response> {
    const body = await readBody(request);
    const { device: signer, roster: current } = await this.#authenticate(request, url, body);
    const { entry } = parseBody(body, isEntryRequest);
    if (entry.by !== signer) fail(403, "Entry is not signed by the requesting device");
    const roster = await this.#append(current, entry, 409);

    const target = entry.device.id;
    if (entry.action === "add") {
      this.#sql.exec("DELETE FROM pairing WHERE device_id = ?", target);
    } else {
      for (const ws of this.#sockets(target)) ws.close(CLOSE_REVOKED, "Device was revoked");
      this.#sql.exec("DELETE FROM queue WHERE sender = ? OR recipient = ?", target, target);
    }
    this.#broadcast({ t: "roster", roster: roster.length });
    return Response.json({ roster: roster.length }, { status: 201 });
  }

  async #connect(request: Request, url: URL): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") fail(426, "Expected a WebSocket upgrade");
    const { device, roster } = await this.#authenticate(request, url);
    for (const old of this.#sockets(device)) old.close(CLOSE_SUPERSEDED, "Replaced by a newer connection");

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [device]);
    const online = this.#sockets()
      .map((ws) => this.#deviceOf(ws))
      .filter((id) => id !== device);
    this.#send(server, { t: "hello", roster: roster.length, online });
    const queued = this.#sql.exec<{ envelope: string }>(
      "SELECT envelope FROM queue WHERE recipient = ? AND expires > ? ORDER BY seq",
      device,
      Date.now(),
    );
    for (const { envelope } of queued) server.send(deliverFrame(envelope));
    this.#broadcast({ t: "presence", device, online: true }, device);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Stores and forwards an envelope from `sender`. Returns why it was rejected, if it was. */
  async #route(sender: string, envelope: Envelope): Promise<string | undefined> {
    const json = JSON.stringify(envelope);
    const roster = await this.#loadRoster();
    const now = Date.now();
    if (utf8(json).byteLength > MAX_ENVELOPE_BYTES) return "envelope is too large";
    if (envelope.from !== sender) return "envelope is not from the sending device";
    if (envelope.to === sender || !roster?.devices.has(envelope.to)) return "recipient is not a member";
    if (envelope.expires <= now) return "envelope has expired";

    const recipient = this.#sockets(envelope.to)[0];
    if (envelope.ephemeral) {
      recipient?.send(deliverFrame(json));
      return;
    }
    const { queued } = this.#sql.exec<{ queued: number }>("SELECT count(*) AS queued FROM queue").one();
    if (queued >= MAX_QUEUED_ENVELOPES) return "relay queue is full";
    // `expires` is part of the authenticated header, so the relay caps how long it keeps the envelope instead.
    const { rowsWritten } = this.#sql.exec(
      `INSERT INTO queue (sender, recipient, id, envelope, expires) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (sender, id) DO NOTHING`,
      sender,
      envelope.to,
      envelope.id,
      json,
      Math.min(envelope.expires, now + MESSAGE_TTL_MS),
    );
    if (!rowsWritten) return; // A retry of an envelope that is already queued.
    recipient?.send(deliverFrame(json));
    await this.#scheduleAlarm();
  }

  /** Checks that a current member signed the request. `body` is the exact request body. */
  async #authenticate(request: Request, url: URL, body = ""): Promise<{ device: string; roster: Roster }> {
    const roster = await this.#loadRoster();
    if (!roster) fail(401, "Network is not initialized");
    const device = await verifyRequest(
      request.headers.get("Authorization"),
      request.method,
      url,
      body,
      (id) => roster.devices.get(id)?.signKey,
      Date.now(),
    ).catch((error) => fail(401, messageOf(error)));
    return { device, roster };
  }

  /** The verified roster, replayed from storage after an eviction. Undefined before the network is initialized. */
  async #loadRoster(): Promise<Roster | undefined> {
    if (!this.#roster) {
      const rows = this.#sql.exec<{ entry: string }>("SELECT entry FROM roster ORDER BY idx").toArray();
      if (rows.length) {
        const roster = await verifyRoster(rows.map(({ entry }) => JSON.parse(entry) as RosterEntry));
        // Another event may have loaded or extended the roster while this one was verifying.
        this.#roster ??= roster;
      }
    }
    return this.#roster;
  }

  /** Validates `entry` as the successor of `current` and persists it. `status` is the error status if invalid. */
  async #append(current: Roster | undefined, entry: RosterEntry, status: number): Promise<Roster> {
    const roster = await applyEntry(current, entry).catch((error) => fail(status, messageOf(error)));
    // Checking signatures yields to other events, which may have appended in the meantime.
    if (this.#roster !== current) fail(409, "Roster changed concurrently");
    this.#sql.exec("INSERT INTO roster (idx, entry) VALUES (?, ?)", current?.length ?? 0, JSON.stringify(entry));
    this.#roster = roster;
    return roster;
  }

  async #scheduleAlarm(): Promise<void> {
    const { next } = this.#sql
      .exec<{ next: number | null }>(
        `SELECT min(expires) AS next FROM
         (SELECT min(expires) AS expires FROM queue UNION ALL SELECT min(expires) FROM pairing)`,
      )
      .one();
    if (next !== null) await this.ctx.storage.setAlarm(next);
  }

  /** Open sockets, of one device or of all. Closing sockets can still be listed by `getWebSockets`. */
  #sockets(device?: string): WebSocket[] {
    return this.ctx.getWebSockets(device).filter((ws) => ws.readyState === WebSocket.OPEN);
  }

  #deviceOf(ws: WebSocket): string {
    const [device] = this.ctx.getTags(ws);
    if (!device) throw new Error("Socket has no device tag");
    return device;
  }

  #send(ws: WebSocket, frame: RelayFrame): void {
    ws.send(JSON.stringify(frame));
  }

  #broadcast(frame: RelayFrame, except?: string): void {
    for (const ws of this.#sockets()) if (this.#deviceOf(ws) !== except) this.#send(ws, frame);
  }
}
