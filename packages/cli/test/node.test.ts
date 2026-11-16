import { beforeEach, expect, test } from "bun:test";
import { createIdentity } from "@agent-message/protocol";
import type { AttachEvent } from "../src/api.ts";
import { Node } from "../src/node.ts";
import { Store } from "../src/store.ts";

const MINUTE = 60_000;
let now: number;
let node: Node;

beforeEach(async () => {
  now = 1_000_000;
  node = new Node(new Store(":memory:"), await createIdentity("mac"), () => now);
});

const claude = (session: string, extra: object = {}) => ({ harness: "claude", session, cwd: "/work/app", ...extra });

/** Attaches a recording channel for a session. */
function attach(session: string, pid: number, name?: string) {
  const events: AttachEvent[] = [];
  let closed = false;
  const attachment = {
    pid,
    send: (event: AttachEvent) => void events.push(event),
    close: () => {
      closed = true;
    },
  };
  const { agent, detach } = node.attach(claude(session, name ? { name } : {}), attachment);
  return {
    agent,
    detach,
    events,
    wakes: () => events.filter((event) => event.type === "wake").length,
    closed: () => closed,
  };
}

test("a session gets a name from its directory and keeps it", () => {
  const agent = node.register(claude("abcd-1234"));
  expect(agent.name).toBe("app-abcd");
  expect(node.register(claude("abcd-1234", { cwd: "/elsewhere", name: "other" })).name).toBe("app-abcd");
  expect(node.register(claude("abcd-9999")).name).toBe("app-abcd9");
  expect(node.whoami({ harness: "claude", session: "abcd-1234" })).toEqual({ address: "app-abcd@mac" });
});

test("a requested name is taken over from a session that is gone, but not from a live one", () => {
  node.register(claude("s1", { name: "reviewer" }));
  node.send({ as: "boss" }, "reviewer", "review this");
  // A new session asks for the same name and inherits the waiting mail.
  node.register(claude("s2", { name: "reviewer" }));
  expect(node.take({ harness: "claude", session: "s2" }).map((message) => message.body)).toEqual(["review this"]);

  attach("s2", 10);
  expect(() => node.register(claude("s3", { name: "reviewer" }))).toThrow("live session");
  expect(() => node.register(claude("s4", { name: "Not Valid" }))).toThrow("Invalid agent name");
});

test("messages are delivered once, in order, to whoever asks as the recipient", async () => {
  node.register(claude("s1", { name: "bob" }));
  const first = await node.send({ as: "alice" }, "bob", "one");
  await node.send({ as: "alice" }, "bob@mac", "two", first.id);
  expect(first).toMatchObject({ to: "bob@mac", recipient: "idle" });

  const messages = node.take({ as: "bob" });
  expect(messages.map((message) => message.body)).toEqual(["one", "two"]);
  expect(messages[1]).toMatchObject({ from: "alice@mac", to: "bob@mac", replyTo: first.id, sentAt: now });
  expect(node.take({ as: "bob" })).toEqual([]);
});

test("sending is refused for bad input and unreachable recipients", async () => {
  node.register(claude("s1", { name: "bob" }));
  const send = (to: string, body = "hi") => node.send({ as: "alice" }, to, body);
  await expect(send("nobody")).rejects.toThrow("No agent named");
  await expect(send("alice")).rejects.toThrow("cannot message itself");
  await expect(send("Bad Address")).rejects.toThrow("Invalid address");
  await expect(send("bob", "  ")).rejects.toThrow("empty");
  await expect(send("bob", "x".repeat(64 * 1024 + 1))).rejects.toThrow("exceeds");
  await expect(send("bob@elsewhere")).rejects.toThrow("not part of a network");
  await expect(node.send({}, "bob", "hi")).rejects.toThrow("Cannot tell which agent");

  await send("bob");
  node.end("claude", "s1");
  await expect(send("bob")).rejects.toThrow("has ended");
});

test("an idle attached session is woken; a busy one is left to its hooks", async () => {
  node.register(claude("s1", { name: "bob" }));
  const bob = attach("s1", 10);
  const self = { harness: "claude", session: "s1" };
  expect(bob.events).toEqual([{ type: "attached", address: "bob@mac" }]);

  // Idle: woken, and the message stays until the session collects it.
  expect(await node.send({ as: "alice" }, "bob", "one")).toMatchObject({ recipient: "live" });
  expect(bob.events.at(-1)).toEqual({ type: "wake", pending: 1 });
  expect(node.take(self, "active")).toHaveLength(1);

  // Mid-turn: no wake, the next hook picks it up.
  await node.send({ as: "alice" }, "bob", "two");
  expect(bob.wakes()).toBe(1);
  // Ending a turn with mail keeps the session busy; ending with none makes it idle again.
  expect(node.take(self, "ending")).toHaveLength(1);
  await node.send({ as: "alice" }, "bob", "three");
  expect(bob.wakes()).toBe(1);
  expect(node.take(self, "ending")).toHaveLength(1);
  expect(node.take(self, "ending")).toHaveLength(0);
  await node.send({ as: "alice" }, "bob", "four");
  expect(bob.wakes()).toBe(2);
});

test("a session that stopped reporting is treated as idle after ten minutes", async () => {
  node.register(claude("s1", { name: "bob" }));
  const bob = attach("s1", 10);
  node.take({ harness: "claude", session: "s1" }, "active");

  now += 10 * MINUTE - 1;
  await node.send({ as: "alice" }, "bob", "one");
  expect(bob.wakes()).toBe(0);
  now += 1;
  await node.send({ as: "alice" }, "bob", "two");
  expect(bob.events.at(-1)).toEqual({ type: "wake", pending: 2 });
});

test("mail that arrived before attaching wakes the session at once", async () => {
  node.register(claude("s1", { name: "bob" }));
  await node.send({ as: "alice" }, "bob", "early");
  expect(attach("s1", 10).events.at(-1)).toEqual({ type: "wake", pending: 1 });
});

test("a second channel for the same session supersedes the first, which may not come back", () => {
  const first = attach("s1", 10, "bob");
  const second = attach("s1", 10, "bob");
  expect(first.events.at(-1)).toEqual({ type: "superseded" });
  expect(first.closed()).toBe(true);
  // The first one detaching late must not take the second one down with it.
  first.detach();
  expect(node.peers().peers).toMatchObject([{ name: "bob", online: true }]);
  second.detach();
  expect(node.peers().peers).toMatchObject([{ name: "bob", online: false }]);
});

test("a channel follows its harness process to a new session", async () => {
  const channel = attach("s1", 4242, "bob");
  // /clear: a hook under the same process reports a session the node has not seen.
  expect(node.register(claude("s2", { ancestors: [77, 4242, 1] })).name).toBe("bob");
  expect(node.whoami({ harness: "claude", session: "s2" })).toEqual({ address: "bob@mac" });
  await node.send({ as: "alice" }, "bob", "still here");
  expect(channel.wakes()).toBe(1);

  // --resume: the process turns out to be an existing session; the channel moves to it and the placeholder goes.
  node.register(claude("old", { name: "veteran" }));
  const resumed = attach("startup-id", 5151);
  expect(node.register(claude("old", { ancestors: [5151] })).name).toBe("veteran");
  await node.send({ as: "alice" }, "veteran", "welcome back");
  expect(resumed.wakes()).toBe(1);
  expect(node.peers().peers.map((peer) => peer.name)).not.toContain(resumed.agent.name);
});

test("peers lists open and attached sessions only", () => {
  node.register(claude("s1", { name: "kept" }));
  node.register(claude("s2", { name: "ended-unused" }));
  node.register(claude("s3", { name: "ended-with-mail" }));
  node.send({ as: "alice" }, "ended-with-mail", "hi");
  node.end("claude", "s2");
  node.end("claude", "s3");
  const live = attach("s4", 10, "live");
  // An attached session is evidently alive whatever its hooks said.
  node.end("claude", "s4");
  expect(node.peers().peers.map((peer) => `${peer.address} ${peer.online}`)).toEqual([
    "alice@mac false",
    "kept@mac false",
    "live@mac true",
  ]);

  now += 8 * 24 * 60 * MINUTE;
  expect(node.peers().peers.map((peer) => peer.name)).toEqual(["live"]);
  live.detach();
});
