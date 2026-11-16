import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  applyEntry,
  createEntry,
  createIdentity,
  type Device,
  type Envelope,
  type Identity,
  type RelayFrame,
  type Roster,
  type RosterEntry,
  sealEnvelope,
  signRequest,
} from "@agent-message/protocol";
import { expect } from "vitest";

const ORIGIN = "https://relay.test";

export type Stub = DurableObjectStub;

/** A relay object of its own, so tests do not share state. */
export const freshRelay = (): Stub => env.RELAY.getByName(crypto.randomUUID());

type CallOptions = { as?: Identity; at?: number; body?: unknown; headers?: HeadersInit };

/** Makes an HTTP request, signed by `as` at time `at` when given. */
async function fetchRelay(stub: Stub, method: string, path: string, options: CallOptions = {}): Promise<Response> {
  const url = new URL(path, ORIGIN);
  const body = options.body === undefined ? "" : JSON.stringify(options.body);
  const headers = new Headers(options.headers);
  if (options.as)
    headers.set("Authorization", await signRequest(options.as, method, url, body, options.at ?? Date.now()));
  return stub.fetch(url, { method, headers, body: method === "GET" ? undefined : body });
}

/** Makes an HTTP request and reads the JSON response. Unread bodies would keep the object from being evicted. */
export async function call(stub: Stub, method: string, path: string, options: CallOptions = {}) {
  const response = await fetchRelay(stub, method, path, options);
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as unknown) : undefined };
}

export const init = (stub: Stub, entry: RosterEntry) =>
  call(stub, "POST", "/v1/init", { body: { entry }, headers: { Authorization: `Bearer ${env.BOOTSTRAP_TOKEN}` } });

/** A network whose first device founded it and added all the others. */
export class Network {
  private constructor(
    readonly stub: Stub,
    readonly devices: Identity[],
    public roster: Roster,
  ) {}

  static async create(stub: Stub, ...names: string[]): Promise<Network> {
    const [founder, ...others] = await Promise.all(names.map(createIdentity));
    const genesis = await createEntry(undefined, "add", founder!.device, founder!, Date.now());
    expect((await init(stub, genesis)).status).toBe(201);
    const network = new Network(stub, [founder!], await applyEntry(undefined, genesis));
    for (const identity of others) await network.add(identity);
    return network;
  }

  /** Appends an entry signed by `by` (the founder by default) and returns the response. */
  async append(action: RosterEntry["action"], device: RosterEntry["device"], by = this.devices[0]!) {
    const entry = await createEntry(this.roster, action, device, by, Date.now());
    const response = await call(this.stub, "POST", "/v1/roster", { as: by, body: { entry } });
    if (response.status === 201) this.roster = await applyEntry(this.roster, entry);
    return response;
  }

  async add(identity: Identity): Promise<void> {
    expect((await this.append("add", identity.device)).status).toBe(201);
    this.devices.push(identity);
  }
}

let envelopes = 0;

export const seal = (
  from: Identity,
  to: Device,
  options: { expires?: number; ephemeral?: true } = {},
): Promise<Envelope> =>
  sealEnvelope({ type: "agents", agents: [], at: 0 }, from, to, {
    id: `e${++envelopes}`,
    expires: options.expires ?? Date.now() + 60_000,
    ...(options.ephemeral && { ephemeral: true }),
  });

/** Gives up on a wait that would otherwise hang until the test times out, naming what was missing. */
const DEADLINE_MS = 4_000;

function deadline<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${what}`)), DEADLINE_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** A device's connection to the relay, reading frames in the order they arrive. */
export class Socket {
  readonly #messages: string[] = [];
  #wake = () => {};
  readonly closed: Promise<{ code: number; reason: string }>;

  private constructor(readonly ws: WebSocket) {
    ws.addEventListener("message", ({ data }) => {
      this.#messages.push(data as string);
      this.#wake();
    });
    this.closed = new Promise((resolve) =>
      ws.addEventListener("close", ({ code, reason }) => resolve({ code, reason })),
    );
    ws.accept();
  }

  static async open(stub: Stub, identity: Identity): Promise<Socket> {
    const response = await fetchRelay(stub, "GET", "/v1/connect", { as: identity, headers: { Upgrade: "websocket" } });
    if (!response.webSocket) throw new Error(`Connect failed with ${response.status}: ${await response.text()}`);
    return new Socket(response.webSocket);
  }

  /** Opens a connection and consumes its `hello` frame. */
  static async connect(stub: Stub, identity: Identity): Promise<[Socket, Extract<RelayFrame, { t: "hello" }>]> {
    const socket = await Socket.open(stub, identity);
    const hello = await socket.next();
    if (hello.t !== "hello") throw new Error(`Expected hello, got ${hello.t}`);
    return [socket, hello];
  }

  /** The next message, as text. */
  text(): Promise<string> {
    const message = this.#messages.shift();
    if (message !== undefined) return Promise.resolve(message);
    const arrived = new Promise<void>((resolve) => {
      this.#wake = resolve;
    });
    return deadline(arrived, "a frame").then(() => this.text());
  }

  async next(): Promise<RelayFrame> {
    return JSON.parse(await this.text()) as RelayFrame;
  }

  send(frame: unknown): void {
    this.ws.send(typeof frame === "string" ? frame : JSON.stringify(frame));
  }

  waitClosed(): Promise<{ code: number; reason: string }> {
    return deadline(this.closed, "the socket to close");
  }
}

/** Runs SQL inside the relay object, for seeding rows and inspecting what it stored. */
export const sql = <T extends Record<string, SqlStorageValue>>(stub: Stub, query: string, ...bindings: unknown[]) =>
  runInDurableObject(stub, (_, state) => state.storage.sql.exec<T>(query, ...bindings).toArray());
