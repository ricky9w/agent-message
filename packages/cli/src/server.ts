import { chmodSync, rmSync } from "node:fs";
import { type Api, ApiError, type AttachEvent, type Op, type Session } from "./api.ts";
import { loadIdentity } from "./identity.ts";
import { log } from "./log.ts";
import { Node } from "./node.ts";
import { databasePath, identityPath, prepareHome, socketPath } from "./paths.ts";
import { Store } from "./store.ts";
import { version } from "./version.ts";

const KEEPALIVE_MS = 20_000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

type Handlers = { [K in Op]: (params: Api[K]["params"]) => Api[K]["result"] | Promise<Api[K]["result"]> };

/** Runs the node in this process until it is told to stop. Returns at once if another node already owns the home. */
export async function runNode(): Promise<void> {
  prepareHome();
  let store: Store;
  try {
    store = new Store(databasePath);
  } catch (error) {
    if ((error as { code?: string }).code?.startsWith("SQLITE_BUSY")) return;
    throw error;
  }
  const node = new Node(store, await loadIdentity(identityPath));
  await node.network.start();
  node.prune();
  const pruning = setInterval(() => node.prune(), PRUNE_INTERVAL_MS);

  const stop = () => {
    clearInterval(pruning);
    node.close();
    void server.stop(true);
    store.close();
    rmSync(socketPath, { force: true });
    log("node stopped");
    // A relay connection that is slow to close must not keep a stopped node alive.
    process.exit(0);
  };

  const { network } = node;
  const handlers: Handlers = {
    ping: () => ({ version, pid: process.pid, device: node.device }),
    register: (session) => {
      const agent = node.register(session);
      return { ...node.whoami({ as: agent.name }), messages: node.take({ as: agent.name }) };
    },
    end: ({ harness, session }) => {
      node.end(harness, session);
      return {};
    },
    whoami: ({ caller }) => node.whoami(caller),
    send: ({ caller, to, body, replyTo }) => node.send(caller, to, body, replyTo),
    take: ({ caller, turn }) => ({ messages: node.take(caller, turn) }),
    peers: () => node.peers(),
    stop: () => {
      setTimeout(stop, 10);
      return {};
    },
    "network.status": () => network.status(),
    "network.init": async ({ relay, token, deviceName }) => {
      await network.init(relay, token, deviceName);
      return network.status();
    },
    "network.join": async ({ relay, network: id, deviceName }) => {
      await network.join(relay, id, deviceName);
      return network.status();
    },
    "network.approve": async ({ code }) => ({ device: await network.approve(code) }),
    "network.revoke": async ({ device }) => {
      await network.revoke(device);
      return {};
    },
    "network.leave": async () => {
      await network.leave();
      return {};
    },
  };

  /** Holds a response open as a stream of newline-delimited events for one attached session. */
  function attach(request: Request, session: Session & { pid: number }): Response {
    const encoder = new TextEncoder();
    let cleanup = () => {};
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let open = true;
        const write = (text: string) => open && controller.enqueue(encoder.encode(text));
        const keepalive = setInterval(() => write("\n"), KEEPALIVE_MS);
        const { detach } = node.attach(session, {
          pid: session.pid,
          send: (event: AttachEvent) => write(`${JSON.stringify(event)}\n`),
          close: () => {
            cleanup();
            controller.close();
          },
        });
        cleanup = () => {
          if (!open) return;
          open = false;
          clearInterval(keepalive);
          detach();
        };
        request.signal.addEventListener("abort", cleanup);
      },
      cancel: () => cleanup(),
    });
    return new Response(body, { headers: { "content-type": "application/x-ndjson" } });
  }

  rmSync(socketPath, { force: true });
  const server = Bun.serve({
    unix: socketPath,
    // Attached sessions hold a response open indefinitely. Bun's types do not offer `idleTimeout`
    // for Unix sockets, yet the runtime applies its 10-second default to them.
    ...({ idleTimeout: 0 } as object),
    async fetch(request) {
      try {
        const { pathname } = new URL(request.url);
        if (request.method === "POST" && pathname === "/attach") {
          return attach(request, (await request.json()) as Session & { pid: number });
        }
        if (request.method === "POST" && pathname === "/rpc") {
          const { op, params } = (await request.json()) as { op: Op; params: never };
          if (!Object.hasOwn(handlers, op)) throw new ApiError("unknown_op", `Unknown operation: ${op}`);
          return Response.json({ result: await handlers[op](params) });
        }
        return new Response("Not found", { status: 404 });
      } catch (error) {
        const known = error instanceof ApiError;
        if (!known) log("request failed", error);
        const message = error instanceof Error ? error.message : String(error);
        return Response.json(
          { error: { code: known ? error.code : "internal", message } },
          { status: known ? 400 : 500 },
        );
      }
    },
  });
  chmodSync(socketPath, 0o600);
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, stop);
  log(`node ${version} started as ${node.device} (pid ${process.pid})`);
}
