import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Directory holding the node's database, identity, socket and log. */
export const home =
  process.env.AGENT_MESSAGE_HOME ??
  join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "agent-message");

export const socketPath = join(home, "node.sock");
export const databasePath = join(home, "node.db");
export const identityPath = join(home, "identity.json");
export const logPath = join(home, "node.log");

/** Unix socket paths are limited to about 104 bytes on macOS and 108 on Linux. */
const MAX_SOCKET_PATH_BYTES = 100;

export function prepareHome(): void {
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) {
    throw new Error(`AGENT_MESSAGE_HOME is too long for a Unix socket path: ${home}`);
  }
  mkdirSync(home, { recursive: true, mode: 0o700 });
}

/** The command that runs this program again. */
export const selfCommand: string[] = [process.execPath, process.argv[1] ?? ""];
