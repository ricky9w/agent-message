import type { Message } from "@agent-message/protocol";
import { rpc } from "./client.ts";
import { renderInbox, renderIntro } from "./render.ts";

/** The fields of a hook's input that both Claude Code and Codex provide. */
type HookInput = {
  hook_event_name: string;
  session_id: string;
  cwd: string;
  /** Set when the hook fires inside a subagent, whose context is not the session's. */
  agent_id?: string;
};

const context = (event: string, text: string) => ({
  hookSpecificOutput: { hookEventName: event, additionalContext: text },
});

/** Process ids of this process's ancestors, nearest first. */
function ancestors(): number[] {
  const { stdout } = Bun.spawnSync(["ps", "-axo", "pid=,ppid="]);
  const parents = new Map(
    stdout
      .toString()
      .split("\n")
      .map((line) => line.trim().split(/\s+/).map(Number) as [number, number]),
  );
  const chain: number[] = [];
  for (let pid = process.ppid; pid > 1 && chain.length < 16; pid = parents.get(pid) ?? 0) chain.push(pid);
  return chain;
}

/**
 * Handles one hook invocation from a harness: reads the event on stdin and prints the hook's JSON result.
 * Session start registers the session; later events hand over whatever arrived in the meantime.
 */
export async function hook(harness: string): Promise<void> {
  const input = (await Bun.stdin.json()) as HookInput;
  const event = input.hook_event_name;
  const session = { harness, session: input.session_id, cwd: input.cwd };
  let output: unknown;

  if (event === "SessionStart") {
    try {
      const { address, messages } = await rpc("register", {
        ...session,
        name: process.env.AGENT_MESSAGE_NAME,
        ancestors: ancestors(),
      });
      output = context(event, [renderIntro(address), ...(messages.length ? [renderInbox(messages)] : [])].join("\n\n"));
    } catch (error) {
      output = context(
        event,
        `agent-message is unavailable in this session: ${error instanceof Error ? error.message : error}`,
      );
    }
  } else if (event === "SessionEnd") {
    await rpc("end", session, { start: false }).catch(() => {});
  } else if (!input.agent_id) {
    // Between turns and tool calls a missing node just means there is nothing to deliver; never start one here.
    const turn = event === "Stop" ? "ending" : "active";
    const messages = await rpc("take", { caller: session, turn }, { start: false }).then(
      (result) => result.messages,
      (): Message[] => [],
    );
    if (messages.length) {
      // A session about to go idle is kept going so that it reads what arrived.
      output =
        event === "Stop" ? { decision: "block", reason: renderInbox(messages) } : context(event, renderInbox(messages));
    }
  }
  if (output) console.log(JSON.stringify(output));
}
