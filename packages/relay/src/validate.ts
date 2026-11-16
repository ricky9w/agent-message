import type { AppendRequest, Device, DeviceFrame, Envelope, PairRequest, RosterEntry } from "@agent-message/protocol";

// Shape checks for untrusted JSON. Whether the contents are acceptable is decided by the protocol functions.

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === "string";

const isDevice = (value: unknown): value is Device =>
  isObject(value) && [value.id, value.name, value.signKey, value.kexKey].every(isString);

const isEntry = (value: unknown): value is RosterEntry =>
  isObject(value) &&
  [value.prev, value.by, value.sig].every(isString) &&
  Number.isFinite(value.at) &&
  (value.action === "add"
    ? isDevice(value.device)
    : value.action === "revoke" && isObject(value.device) && isString(value.device.id));

const isEnvelope = (value: unknown): value is Envelope =>
  isObject(value) &&
  [value.id, value.from, value.to, value.box].every(isString) &&
  Number.isFinite(value.expires) &&
  (value.ephemeral === undefined || value.ephemeral === true);

/** Body of `POST /v1/init` and `POST /v1/roster`. */
export const isEntryRequest = (value: unknown): value is AppendRequest => isObject(value) && isEntry(value.entry);

export const isPairRequest = (value: unknown): value is PairRequest => isObject(value) && isDevice(value.device);

export function parseFrame(text: string): DeviceFrame | undefined {
  let frame: unknown;
  try {
    frame = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObject(frame)) return undefined;
  if (frame.t === "send" && isEnvelope(frame.envelope)) return { t: "send", envelope: frame.envelope };
  if (frame.t === "ack" && isString(frame.id)) return { t: "ack", id: frame.id };
  return undefined;
}
