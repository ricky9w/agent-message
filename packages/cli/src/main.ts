#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { ApiError, type Caller, type NetworkStatus } from "./api.ts";
import { channel } from "./channel.ts";
import { NodeUnavailable, rpc } from "./client.ts";
import { hook } from "./hook.ts";
import { logPath } from "./paths.ts";
import { renderMessage } from "./render.ts";
import { runNode } from "./server.ts";
import { version } from "./version.ts";

const USAGE = `agent-message ${version} — messaging between coding agents

Usage: agent-message <command> [options]

Messaging
  send <to> [text]        Send a message; reads the text from stdin when omitted or "-"
      --reply-to <id>       Mark it as the answer to an earlier message
  inbox                   Print and clear the messages waiting for you
  peers                   List the agents you can reach
  whoami                  Print your own address

Devices (optional, for messaging across machines)
  relay init <url>        Found a network on a freshly deployed relay
  relay join <url#id>     Ask to join a network; prints a code to approve elsewhere
  relay invite            Print the join command for another device
  relay status            Show the relay connection and member devices
  relay leave             Remove this device from its network
  devices approve <code>  Admit the device showing this code
  devices revoke <name>   Remove a device from the network

Node
  node start|stop|status  Control the background node (it starts on demand)
  node run                Run the node in the foreground

Options
  --as <name>             Act as this agent instead of the current session
  --device-name <name>    Name for this device when founding or joining a network
  --json                  Print machine-readable output
  -h, --help              Show this help
  -v, --version           Show the version

Addresses are <agent> for this device or <agent>@<device> for another one.`;

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    as: { type: "string" },
    "reply-to": { type: "string" },
    "device-name": { type: "string" },
    json: { type: "boolean" },
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
  },
});

/** Prints the JSON form when asked for it, the readable form otherwise. */
const print = (data: unknown, text: string) => console.log(flags.json ? JSON.stringify(data) : text);

/**
 * Who is running this command. Harnesses export their session id to the commands an agent runs.
 * Codex is checked first because a Codex session started from Claude Code inherits both variables.
 */
function caller(): Caller {
  const { AGENT_MESSAGE_AS, CODEX_THREAD_ID, CLAUDE_CODE_SESSION_ID } = process.env;
  const cwd = process.cwd();
  if (flags.as ?? AGENT_MESSAGE_AS) return { as: flags.as ?? AGENT_MESSAGE_AS, cwd };
  if (CODEX_THREAD_ID) return { harness: "codex", session: CODEX_THREAD_ID, cwd };
  if (CLAUDE_CODE_SESSION_ID) return { harness: "claude", session: CLAUDE_CODE_SESSION_ID, cwd };
  return { cwd };
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new ApiError("usage", `Missing ${name}. Run \`agent-message --help\`.`);
  return value;
}

function describe(status: NetworkStatus): string {
  switch (status.state) {
    case "none":
      return "Not part of a network. Local agents can still message each other.";
    case "joining":
      return `Waiting for approval. On a member device run:\n  agent-message devices approve ${status.code}`;
    case "stopped":
      return `Disconnected from ${status.relay}: ${status.reason}`;
    case "joined": {
      const devices = status.devices.map(
        (d) => `  ${d.name}${d.self ? " (this device)" : ""}  ${d.online ? "online" : "offline"}`,
      );
      const link = status.connected ? "connected" : "not connected";
      return [`Relay ${status.relay} (${link}), network ${status.network}, ${status.pending} queued`, ...devices].join(
        "\n",
      );
    }
  }
}

/**
 * The status once the node's connection to the relay is up. The node connects in the background after
 * founding or joining, so the status right after either would say "not connected". Gives up after a
 * few seconds and reports whatever the state is then.
 */
async function connectedStatus(): Promise<NetworkStatus> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const status = await rpc("network.status", {});
    if (status.state !== "joined" || status.connected || Date.now() > deadline) return status;
    await Bun.sleep(200);
  }
}

async function relay(action: string | undefined, argument: string | undefined): Promise<void> {
  const deviceName = flags["device-name"];
  switch (action) {
    case "init": {
      const token = process.env.AGENT_MESSAGE_BOOTSTRAP_TOKEN ?? prompt("Bootstrap token:") ?? "";
      await rpc("network.init", { relay: required(argument, "relay URL"), token: token.trim(), deviceName });
      const status = await connectedStatus();
      return print(status, describe(status));
    }
    case "join": {
      const url = new URL(required(argument, "join URL"));
      const network = required(url.hash.slice(1), "network id (the part after # in the join URL)");
      let status = await rpc("network.join", { relay: url.origin, network, deviceName });
      if (!flags.json) console.log(describe(status));
      while (status.state === "joining") {
        await Bun.sleep(1000);
        status = await rpc("network.status", {});
      }
      if (status.state !== "joined") throw new ApiError("join_failed", `Joining failed; see ${logPath}`);
      status = await connectedStatus();
      return print(status, describe(status));
    }
    case "invite": {
      const status = await rpc("network.status", {});
      if (status.state !== "joined") throw new ApiError("no_network", describe(status));
      const command = `agent-message relay join ${new URL(`#${status.network}`, status.relay)}`;
      return print({ command }, `On the new device run:\n  ${command}`);
    }
    case "status": {
      const status = await rpc("network.status", {});
      return print(status, describe(status));
    }
    case "leave":
      return print(await rpc("network.leave", {}), "Left the network.");
    default:
      throw new ApiError("usage", "Usage: agent-message relay init|join|invite|status|leave");
  }
}

async function devices(action: string | undefined, argument: string | undefined): Promise<void> {
  switch (action) {
    case "approve": {
      const result = await rpc("network.approve", { code: required(argument, "pairing code") });
      return print(result, `Added ${result.device} to the network.`);
    }
    case "revoke": {
      const device = required(argument, "device name");
      return print(await rpc("network.revoke", { device }), `Removed ${device} from the network.`);
    }
    default:
      throw new ApiError("usage", "Usage: agent-message devices approve <code> | revoke <name>");
  }
}

async function node(action: string | undefined): Promise<void> {
  switch (action) {
    case "run":
      return runNode();
    case "start":
    case "status": {
      const status = await rpc("ping", {}, { start: action === "start" });
      return print(status, `Node ${status.version} is running as ${status.device} (pid ${status.pid}).`);
    }
    case "stop":
      return print(await rpc("stop", {}, { start: false }), "Node stopped.");
    default:
      throw new ApiError("usage", "Usage: agent-message node start|stop|status|run");
  }
}

async function main(): Promise<void> {
  const [command, first, second] = positionals;
  if (flags.version) return console.log(version);
  if (flags.help || !command) return console.log(USAGE);

  switch (command) {
    case "send": {
      const to = required(first, "recipient");
      const body = second === undefined || second === "-" ? await Bun.stdin.text() : second;
      const result = await rpc("send", { caller: caller(), to, body, replyTo: flags["reply-to"] });
      const outcome = {
        live: "The recipient is live and is being notified.",
        idle: "It will be read when the recipient is next active.",
        remote: "It is on its way to the other device.",
      }[result.recipient];
      return print(result, `Sent ${result.id} to ${result.to}. ${outcome}`);
    }
    case "inbox": {
      const { messages } = await rpc("take", { caller: caller() });
      return print(messages, messages.length ? messages.map(renderMessage).join("\n\n") : "No new messages.");
    }
    case "peers": {
      const { peers } = await rpc("peers", {});
      const rows = peers.map((peer) => [peer.address, peer.harness, peer.online ? "live" : "idle", peer.cwd]);
      const widths = [0, 1, 2].map((column) => Math.max(...rows.map((row) => row[column]!.length)));
      const table = rows.map((row) =>
        row
          .map((cell, column) => cell.padEnd(widths[column] ?? 0))
          .join("  ")
          .trimEnd(),
      );
      return print(peers, rows.length ? table.join("\n") : "No agents are registered.");
    }
    case "whoami": {
      const result = await rpc("whoami", { caller: caller() });
      return print(result, result.address);
    }
    case "relay":
      return relay(first, second);
    case "devices":
      return devices(first, second);
    case "node":
      return node(first);
    // The two commands below are run by harness plugins, not by people.
    case "hook":
      return hook(required(first, "harness"));
    case "channel":
      return channel();
    default:
      throw new ApiError("usage", `Unknown command: ${command}. Run \`agent-message --help\`.`);
  }
}

try {
  await main();
  // The node keeps the process alive by itself; every other command is done once main returns.
  if (!(positionals[0] === "node" && positionals[1] === "run")) process.exit(0);
} catch (error) {
  const message = error instanceof ApiError || error instanceof NodeUnavailable ? error.message : String(error);
  if (flags.json)
    console.error(JSON.stringify({ error: { code: error instanceof ApiError ? error.code : "error", message } }));
  else console.error(`agent-message: ${message}`);
  process.exit(1);
}
