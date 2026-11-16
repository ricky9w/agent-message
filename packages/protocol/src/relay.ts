import { type Device, type Identity, sign, verify } from "./device.ts";
import { base64url, sha256, utf8 } from "./encoding.ts";
import type { Envelope } from "./envelope.ts";
import type { RosterEntry } from "./roster.ts";

/** How far a signed request's timestamp may be from the relay's clock. */
export const AUTH_SKEW_MS = 2 * 60 * 1000;

/** How long a pairing request waits for approval. */
export const PAIRING_TTL_MS = 10 * 60 * 1000;

/** Frames a device sends to the relay over its WebSocket. */
export type DeviceFrame =
  | { t: "send"; envelope: Envelope }
  /** The envelope is safely stored on this device; the relay may delete it. */
  | { t: "ack"; id: string };

/** Frames the relay sends to a device. */
export type RelayFrame =
  /** First frame after connecting: the roster length and the ids of the other connected devices. */
  | { t: "hello"; roster: number; online: string[] }
  | { t: "deliver"; envelope: Envelope }
  /** The relay took responsibility for the envelope; the sender may forget it. */
  | { t: "sent"; id: string }
  /** The relay will never deliver the envelope. */
  | { t: "rejected"; id: string; reason: string }
  /** The roster grew to this length. */
  | { t: "roster"; roster: number }
  | { t: "presence"; device: string; online: boolean };

/** WebSocket close codes with a meaning beyond "reconnect later". */
export const CLOSE_SUPERSEDED = 4001;
export const CLOSE_REVOKED = 4003;

/** Bodies of the relay's HTTP endpoints. */
export type InitRequest = { entry: RosterEntry };
export type PairRequest = { device: Device };
export type RosterResponse = { entries: RosterEntry[] };
export type AppendRequest = { entry: RosterEntry };

const SCHEME = "AgentMessage";

async function requestBytes(method: string, url: URL, timestamp: string, body: string) {
  const digest = base64url(await sha256(utf8(body)));
  return utf8(
    ["agent-message/v1/request", method.toUpperCase(), url.host + url.pathname + url.search, timestamp, digest].join(
      "\n",
    ),
  );
}

/** Value of the `Authorization` header proving that `identity` made this exact request now. */
export async function signRequest(
  identity: Identity,
  method: string,
  url: URL,
  body: string,
  now: number,
): Promise<string> {
  const timestamp = String(now);
  const signature = await sign(identity.secret, await requestBytes(method, url, timestamp, body));
  return `${SCHEME} ${identity.device.id}.${timestamp}.${signature}`;
}

/**
 * Checks an `Authorization` header and returns the id of the device that signed the request.
 * `signKeyOf` supplies the key to check against, so the caller decides who counts as known.
 */
export async function verifyRequest(
  header: string | null,
  method: string,
  url: URL,
  body: string,
  signKeyOf: (id: string) => string | undefined,
  now: number,
): Promise<string> {
  const [scheme, token] = (header ?? "").split(" ");
  const [id, timestamp, signature] = (token ?? "").split(".");
  if (scheme !== SCHEME || !id || !timestamp || !signature) throw new Error("Missing credentials");
  if (!(Math.abs(now - Number(timestamp)) <= AUTH_SKEW_MS)) throw new Error("Request timestamp is out of range");
  const signKey = signKeyOf(id);
  if (!signKey || !(await verify(signKey, await requestBytes(method, url, timestamp, body), signature))) {
    throw new Error("Invalid credentials");
  }
  return id;
}
