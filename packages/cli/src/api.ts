import type { AgentInfo, Message } from "@agent-message/protocol";

/** Who is making a request: a named agent, or the harness session the command runs in. */
export type Caller = { as?: string; harness?: string; session?: string; cwd?: string };

export type Session = { harness: string; session: string; cwd: string; name?: string };

export type Peer = AgentInfo & { address: string; device: string };

export type DeviceStatus = { name: string; id: string; self: boolean; online: boolean };

export type NetworkStatus =
  | { state: "none" }
  /** Waiting for a member device to approve this one. */
  | { state: "joining"; relay: string; code: string }
  | { state: "joined"; relay: string; network: string; connected: boolean; pending: number; devices: DeviceStatus[] }
  /** The relay refused this device for good; `reason` says why. */
  | { state: "stopped"; relay: string; reason: string };

/** Requests the node answers on its Unix socket, as `POST /rpc` with `{ op, params }`. */
export type Api = {
  ping: { params: Record<string, never>; result: { version: string; pid: number; device: string } };
  /** A harness session started or resumed. `ancestors` are the caller's parent process ids, nearest first. */
  register: { params: Session & { ancestors?: number[] }; result: { address: string; messages: Message[] } };
  /** A harness session ended. */
  end: { params: { harness: string; session: string }; result: Record<string, never> };
  whoami: { params: { caller: Caller }; result: { address: string } };
  send: {
    params: { caller: Caller; to: string; body: string; replyTo?: string };
    /** `live`: the recipient's session was woken. `idle`: it reads the message when next active. `remote`: queued for another device. */
    result: { id: string; to: string; recipient: "live" | "idle" | "remote" };
  };
  /**
   * Returns the caller's undelivered messages and marks them delivered. A harness hook also reports
   * where the session's turn stands: `active` while it is working, `ending` when it is about to go idle.
   */
  take: { params: { caller: Caller; turn?: "active" | "ending" }; result: { messages: Message[] } };
  peers: { params: Record<string, never>; result: { device: string; peers: Peer[] } };
  stop: { params: Record<string, never>; result: Record<string, never> };
  "network.status": { params: Record<string, never>; result: NetworkStatus };
  "network.init": { params: { relay: string; token: string; deviceName?: string }; result: NetworkStatus };
  "network.join": { params: { relay: string; network: string; deviceName?: string }; result: NetworkStatus };
  "network.approve": { params: { code: string }; result: { device: string } };
  "network.revoke": { params: { device: string }; result: Record<string, never> };
  "network.leave": { params: Record<string, never>; result: Record<string, never> };
};

export type Op = keyof Api;

/** Events on the stream a harness adapter holds open with `POST /attach`. */
export type AttachEvent =
  | { type: "attached"; address: string }
  /** Messages are waiting and the session looks idle: prompt it to collect them. */
  | { type: "wake"; pending: number }
  /** Another process attached as the same agent. The receiver must not attach again. */
  | { type: "superseded" };

/** An error the node reports to its caller, with a stable `code`. */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
