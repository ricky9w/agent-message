import { openSync } from "node:fs";
import { type Api, ApiError, type AttachEvent, type Op, type Session } from "./api.ts";
import { logPath, prepareHome, selfCommand, socketPath } from "./paths.ts";

const START_TIMEOUT_MS = 10_000;

/** Thrown when the node is not running and the caller asked not to start it. */
export class NodeUnavailable extends Error {}

const post = (path: string, body: unknown, signal?: AbortSignal) =>
  fetch(`http://localhost${path}`, { unix: socketPath, method: "POST", body: JSON.stringify(body), signal });

/** `fetch` rejects before any response when nothing listens on the socket. */
async function connect(path: string, body: unknown, start: boolean, signal?: AbortSignal): Promise<Response> {
  try {
    return await post(path, body, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    if (!start) throw new NodeUnavailable("The agent-message node is not running");
  }
  await startNode();
  return post(path, body, signal);
}

/** Launches the node in the background and waits until it answers. */
async function startNode(): Promise<void> {
  prepareHome();
  const log = openSync(logPath, "a");
  Bun.spawn([...selfCommand, "node", "run"], { stdin: "ignore", stdout: log, stderr: log, detached: true }).unref();
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await Bun.sleep(50);
    if (
      await post("/rpc", { op: "ping", params: {} }).then(
        (response) => response.ok,
        () => false,
      )
    )
      return;
  }
  throw new Error(`The agent-message node did not start; see ${logPath}`);
}

/** Calls the node. By default the node is started first if it is not running. */
export async function rpc<K extends Op>(
  op: K,
  params: Api[K]["params"],
  { start = true } = {},
): Promise<Api[K]["result"]> {
  const response = await connect("/rpc", { op, params }, start);
  const body = (await response.json()) as { result: Api[K]["result"] } | { error: { code: string; message: string } };
  if ("error" in body) throw new ApiError(body.error.code, body.error.message);
  return body.result;
}

/** Attaches to the node as a push channel and yields its events until the stream ends or `signal` aborts. */
export async function* attach(session: Session & { pid: number }, signal: AbortSignal): AsyncGenerator<AttachEvent> {
  const response = await connect("/attach", session, true, signal);
  if (!response.ok || !response.body) throw new Error(`Attach failed: ${await response.text()}`);
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) if (line) yield JSON.parse(line) as AttachEvent;
  }
}
