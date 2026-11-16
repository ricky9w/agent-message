import {
  CLOSE_REVOKED,
  CLOSE_SUPERSEDED,
  type DeviceFrame,
  type Identity,
  type RelayFrame,
  signRequest,
} from "@agent-message/protocol";
import { log } from "./log.ts";

const PING_INTERVAL_MS = 30_000;
/** A connection that has been silent this long is assumed dead. */
const SILENCE_LIMIT_MS = 75_000;
/** A connection must last this long before the next failure counts as a first failure again. */
const STABLE_MS = 30_000;
const MAX_DELAY_MS = 60_000;

/** Delay before reconnect attempt number `attempt` (0-based): 1s doubling to a minute, ±20%. */
export const reconnectDelay = (attempt: number, random: number = Math.random()): number =>
  Math.min(MAX_DELAY_MS, 1000 * 2 ** Math.min(attempt, 10)) * (0.8 + 0.4 * random);

export type LinkHandlers = {
  /** Runs before each connection attempt. Throwing {@link Stop} ends the link; any other error means retry later. */
  prepare(): Promise<void>;
  /** Handles one frame. Frames are processed strictly in order. */
  frame(frame: RelayFrame): Promise<void>;
  disconnected(): void;
  /** The link ended for good and will not reconnect. */
  stopped(reason: string): void;
};

/** Thrown by `prepare` when the relay will never accept this device again. */
export class Stop extends Error {}

/** Keeps one authenticated WebSocket to the relay open, reconnecting with backoff until stopped. */
export class RelayLink {
  private socket?: WebSocket;
  private timer?: Timer;
  private attempt = 0;
  private stopped = false;
  private queue = Promise.resolve();

  constructor(
    private readonly relay: URL,
    private readonly identity: Identity,
    private readonly handlers: LinkHandlers,
    private readonly now: () => number,
  ) {
    void this.connect();
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  /** Sends a frame if connected. Whatever is not sent now is the caller's to resend after the next `hello`. */
  send(frame: DeviceFrame): void {
    if (this.connected) this.socket?.send(JSON.stringify(frame));
  }

  close(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.socket?.close();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.handlers.prepare();
    } catch (error) {
      if (error instanceof Stop) return this.stop(error.message);
      return this.retry(error);
    }
    if (this.stopped) return;

    const url = new URL("/v1/connect", this.relay);
    const authorization = await signRequest(this.identity, "GET", url, "", this.now());
    url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
    // Headers on a WebSocket are a Bun extension; the standard constructor has no way to authenticate the upgrade.
    const socket = new WebSocket(url, { headers: { authorization } } as unknown as string[]);
    this.socket = socket;
    const openedAt = this.now();
    let heardAt = openedAt;
    const ping = setInterval(() => {
      if (this.now() - heardAt > SILENCE_LIMIT_MS) socket.close();
      else if (socket.readyState === WebSocket.OPEN) socket.send("ping");
    }, PING_INTERVAL_MS);

    socket.onmessage = (event) => {
      heardAt = this.now();
      if (event.data === "pong") return;
      const frame = JSON.parse(String(event.data)) as RelayFrame;
      this.queue = this.queue.then(() => this.handlers.frame(frame)).catch((error) => log("relay frame failed", error));
    };
    socket.onclose = (event) => {
      clearInterval(ping);
      if (this.socket === socket) this.socket = undefined;
      this.handlers.disconnected();
      if (event.code === CLOSE_SUPERSEDED) return this.stop("Another node connected to the relay as this device");
      if (event.code === CLOSE_REVOKED) return this.stop("This device was removed from the network");
      if (this.now() - openedAt >= STABLE_MS) this.attempt = 0;
      this.retry(`closed (${event.code})`);
    };
  }

  private retry(cause: unknown): void {
    if (this.stopped) return;
    const delay = reconnectDelay(this.attempt++);
    log(`relay connection lost, retrying in ${Math.round(delay / 1000)}s`, cause);
    this.timer = setTimeout(() => void this.connect(), delay);
  }

  private stop(reason: string): void {
    if (this.stopped) return;
    this.stopped = true;
    log(`relay link stopped: ${reason}`);
    this.handlers.stopped(reason);
  }
}
