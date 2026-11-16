import { isName } from "./address.ts";
import { type Device, deviceId, type Identity, sign, verify } from "./device.ts";
import { base32, base64url, canonical, sha256, utf8 } from "./encoding.ts";

/**
 * One step in a network's device history. The roster is an append-only, hash-chained log:
 * the first entry adds the founding device (signed by itself), and every later entry is
 * signed by a device that was a member when it was appended.
 */
export type RosterEntry = {
  /** Hash of the previous entry, or "" for the first. */
  prev: string;
  action: "add" | "revoke";
  /** The device being added, or just the id of the one being revoked. */
  device: Device | { id: string };
  /** Id of the signing device. */
  by: string;
  /** Milliseconds since the Unix epoch. Informational only. */
  at: number;
  /** Ed25519 signature by `by` over the canonical form of every other field. */
  sig: string;
};

/** The result of replaying a roster log. */
export type Roster = {
  /** Network id: a fingerprint of the first entry. Devices pin it when they join. */
  network: string;
  /** Hash of the last entry. */
  head: string;
  length: number;
  /** Current members by id. */
  devices: ReadonlyMap<string, Device>;
  /** Every id that was ever added. A revoked device cannot be added again. */
  seen: ReadonlySet<string>;
};

const entryHash = async (entry: RosterEntry): Promise<string> => base64url(await sha256(utf8(canonical(entry))));
const signedBytes = ({ sig: _, ...rest }: RosterEntry) => utf8(canonical(rest));

/** Builds and signs the entry that appends to `roster`, or founds a network when `roster` is undefined. */
export async function createEntry(
  roster: Roster | undefined,
  action: RosterEntry["action"],
  device: RosterEntry["device"],
  signer: Identity,
  at: number,
): Promise<RosterEntry> {
  const entry = { prev: roster?.head ?? "", action, device, by: signer.device.id, at };
  return { ...entry, sig: await sign(signer.secret, utf8(canonical(entry))) };
}

/** Validates `entry` against `roster` and returns the roster that results. Throws if the entry is not acceptable. */
export async function applyEntry(roster: Roster | undefined, entry: RosterEntry): Promise<Roster> {
  const devices = new Map(roster?.devices);
  const seen = new Set(roster?.seen);
  if (entry.prev !== (roster?.head ?? "")) throw new Error("Roster entry does not follow the current head");

  if (entry.action === "add") {
    const device = entry.device as Device;
    if (!isName(device.name)) throw new Error("Invalid device name");
    if (device.id !== (await deviceId(device.signKey, device.kexKey)))
      throw new Error("Device id does not match its keys");
    if (seen.has(device.id)) throw new Error("Device was already added");
    if ([...devices.values()].some((member) => member.name === device.name)) throw new Error("Device name is taken");
    const { id, name, signKey, kexKey } = device;
    devices.set(id, { id, name, signKey, kexKey });
    seen.add(id);
  } else if (entry.action === "revoke") {
    if (!roster || !devices.delete(entry.device.id)) throw new Error("Device is not a member");
  } else {
    throw new Error("Unknown roster action");
  }

  // The founding entry is self-signed; every other entry needs a signer who was already a member.
  const signer = roster ? roster.devices.get(entry.by) : devices.get(entry.by);
  if (!signer || !(await verify(signer.signKey, signedBytes(entry), entry.sig))) {
    throw new Error("Roster entry is not signed by a member");
  }

  const head = await entryHash(entry);
  const network = roster?.network ?? base32((await sha256(utf8(head))).subarray(0, 16));
  return { network, head, length: (roster?.length ?? 0) + 1, devices, seen };
}

/** Replays a whole log, optionally continuing from an already verified roster. */
export async function verifyRoster(entries: RosterEntry[], from?: Roster): Promise<Roster> {
  let roster = from;
  for (const entry of entries) roster = await applyEntry(roster, entry);
  if (!roster) throw new Error("Roster is empty");
  return roster;
}

export const findDevice = (roster: Roster, name: string): Device | undefined =>
  [...roster.devices.values()].find((device) => device.name === name);
