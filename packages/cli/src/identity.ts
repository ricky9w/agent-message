import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { createIdentity, type Identity, toName } from "@agent-message/protocol";

/** Reads this device's keys, creating them on first use. The device is named after the host until it joins a network. */
export async function loadIdentity(path: string): Promise<Identity> {
  if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as Identity;
  const identity = await createIdentity(toName(hostname().split(".")[0] ?? "") || "device");
  saveIdentity(path, identity);
  return identity;
}

export function saveIdentity(path: string, identity: Identity): void {
  writeFileSync(path, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}
