import { attach } from "./client.ts";
import { reconnectDelay } from "./link.ts";
import { CHANNEL_INSTRUCTIONS, renderWake } from "./render.ts";
import { version } from "./version.ts";

/** MCP revisions this server can speak. It only ever sends notifications, which all of them share. */
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const STABLE_MS = 30_000;

type JsonRpc = { jsonrpc: "2.0"; id?: number | string; method?: string; params?: Record<string, unknown> };

const write = (message: Omit<JsonRpc, "jsonrpc"> & { result?: unknown; error?: unknown }) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

/**
 * Whether the harness will inject channel notifications into the session. Claude Code drops them silently
 * unless it was launched with a channel flag naming this server, and offers no way to ask, so look at its
 * arguments. A wrong guess only mislabels the session as live or idle: messages are delivered either way.
 */
function channelEnabled(): boolean {
  const override = process.env.AGENT_MESSAGE_PUSH;
  if (override) return override === "1";
  const args = Bun.spawnSync(["ps", "-o", "args=", "-p", String(process.ppid)]).stdout.toString();
  return /--(dangerously-load-development-)?channels\b.*agent-message/.test(args);
}

/** Stays attached to the node for as long as `signal` allows, waking the session when messages arrive. */
async function stayAttached(session: string, signal: AbortSignal): Promise<void> {
  for (let attempt = 0; !signal.aborted; attempt++) {
    const attachedAt = Date.now();
    try {
      const self = {
        harness: "claude",
        session,
        cwd: process.cwd(),
        name: process.env.AGENT_MESSAGE_NAME,
        pid: process.ppid,
      };
      for await (const event of attach(self, signal)) {
        if (event.type === "superseded") return;
        if (event.type === "wake")
          write({ method: "notifications/claude/channel", params: { content: renderWake(event.pending) } });
      }
    } catch (error) {
      if (!signal.aborted) console.error(`agent-message: ${error instanceof Error ? error.message : error}`);
    }
    // Only a connection that held for a while resets the backoff, so a flapping one cannot spin.
    if (Date.now() - attachedAt >= STABLE_MS) attempt = 0;
    await Bun.sleep(reconnectDelay(attempt));
  }
}

/**
 * A minimal MCP server over stdio that declares the Claude Code channel capability and uses it to wake
 * an idle session when messages arrive. It offers no tools: agents read and send with the CLI.
 */
export async function channel(): Promise<void> {
  const session = process.env.CLAUDE_CODE_SESSION_ID;
  const abort = new AbortController();
  let attached = false;

  const handle = ({ id, method, params }: JsonRpc) => {
    if (method === "initialize") {
      const requested = String(params?.protocolVersion);
      write({
        id,
        result: {
          protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
          capabilities: { experimental: { "claude/channel": {} } },
          serverInfo: { name: "agent-message", version },
          instructions: CHANNEL_INSTRUCTIONS,
        },
      });
    } else if (method === "notifications/initialized") {
      if (session && !attached && channelEnabled()) void stayAttached(session, abort.signal);
      attached = true;
    } else if (method === "ping") {
      write({ id, result: {} });
    } else if (id !== undefined && method) {
      write({ id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  };

  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) handle(JSON.parse(line) as JsonRpc);
  }
  // The harness closed our input: the session is over.
  abort.abort();
}
