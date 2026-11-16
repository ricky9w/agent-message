/** Agent and device names: lowercase, 1–63 characters, starting with a letter or digit. */
const NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/;

export const isName = (value: unknown): value is string => typeof value === "string" && NAME.test(value);

/** Turns arbitrary text (a hostname, a directory name) into a valid name, or "" if nothing usable remains. */
export function toName(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 63)
    .replace(/[^a-z0-9]+$/, "");
}

export type Address = { agent: string; device?: string };

/** Parses `agent` or `agent@device`. */
export function parseAddress(text: string): Address {
  const [agent, device, ...rest] = text.split("@");
  if (!isName(agent) || rest.length || (device !== undefined && !isName(device))) {
    throw new Error(`Invalid address: ${text}`);
  }
  return device === undefined ? { agent } : { agent, device };
}

export const formatAddress = (agent: string, device: string): string => `${agent}@${device}`;
