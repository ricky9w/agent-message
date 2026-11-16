/**
 * End to end: a real relay (the Worker under `wrangler dev`) and two real nodes, each driven
 * through the CLI as a separate device. Slow by nature; run with `bun run e2e`.
 *
 * To check a deployed relay instead, set AGENT_MESSAGE_E2E_RELAY to its URL and
 * AGENT_MESSAGE_BOOTSTRAP_TOKEN to its token. The relay must not have a network yet, and the test
 * leaves one behind, so delete and redeploy the relay afterwards.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NetworkStatus } from "../packages/cli/src/api.ts";
import { until } from "../packages/cli/test/until.ts";

const root = join(import.meta.dir, "..");
const main = join(root, "packages/cli/src/main.ts");
const scratch = mkdtempSync(join(tmpdir(), "am-"));
const deployed = process.env.AGENT_MESSAGE_E2E_RELAY;
const TOKEN = (deployed && process.env.AGENT_MESSAGE_BOOTSTRAP_TOKEN) || "e2e-bootstrap-token";

let relay: string;
let wrangler: Bun.Subprocess | undefined;

/** A device: its own home directory, hence its own node, identity and database. */
function device(name: string) {
  const env = { ...process.env, AGENT_MESSAGE_HOME: join(scratch, name), AGENT_MESSAGE_BOOTSTRAP_TOKEN: TOKEN };
  const run = async (...args: string[]) => {
    const child = Bun.spawn(["bun", main, ...args], { env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout: stdout.trim(), stderr: stderr.trim(), code };
  };
  const json = async <T>(...args: string[]) => {
    const { stdout, stderr, code } = await run(...args, "--json");
    if (code !== 0) throw new Error(`${args.join(" ")}: ${stderr}`);
    return JSON.parse(stdout) as T;
  };
  return { name, run, json, status: () => json<NetworkStatus>("relay", "status") };
}

const alpha = device("alpha");
const beta = device("beta");

beforeAll(async () => {
  if (deployed) {
    relay = deployed;
    return;
  }
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port;
  await probe.stop(true);
  relay = `http://localhost:${port}`;
  wrangler = Bun.spawn(
    [
      "bunx",
      "wrangler",
      "dev",
      "--port",
      String(port),
      "--var",
      `BOOTSTRAP_TOKEN:${TOKEN}`,
      "--persist-to",
      join(scratch, "relay"),
    ],
    { cwd: join(root, "packages/relay"), stdout: "ignore", stderr: "ignore" },
  );
  await until(
    async () => {
      if (wrangler?.exitCode !== null) throw new Error("wrangler dev exited");
      return fetch(`${relay}/v1`).then(
        (response) => response.ok,
        () => false,
      );
    },
    "the relay to answer",
    60_000,
  );
}, 70_000);

afterAll(async () => {
  for (const each of [alpha, beta]) await each.run("node", "stop");
  wrangler?.kill();
  rmSync(scratch, { recursive: true, force: true });
});

test("two devices pair through the relay and their agents exchange messages", async () => {
  // Found the network on alpha.
  const founded = await alpha.run("relay", "init", relay, "--device-name", "alpha");
  expect(founded.code).toBe(0);
  // The command reports the state once the connection is up, not the moment before.
  expect(founded.stdout).toContain("(connected)");
  expect(founded.stdout).toContain("alpha (this device)  online");
  const { command } = await alpha.json<{ command: string }>("relay", "invite");
  const joinUrl = command.split(" ").at(-1)!;

  // A wrong bootstrap token or a second founding is refused.
  expect((await beta.run("relay", "init", relay)).stderr).toContain("already initialized");

  // Beta asks to join and shows a code; alpha approves it.
  const joining = beta.run("relay", "join", joinUrl, "--device-name", "beta");
  const pending = await until(async () => {
    const status = await beta.status();
    return status.state === "joining" && status;
  }, "beta to show a pairing code");
  expect((await alpha.run("devices", "approve", "aaaa-aaaa-aaaa")).stderr).toContain("No pending pairing request");
  expect((await alpha.run("devices", "approve", pending.code)).stdout).toBe("Added beta to the network.");
  expect((await joining).stdout).toContain("(connected)");

  // Both see each other online.
  for (const each of [alpha, beta]) {
    await until(async () => {
      const status = await each.status();
      return status.state === "joined" && status.devices.length === 2 && status.devices.every((d) => d.online);
    }, `${each.name} to see both devices online`);
  }

  // Each device learns the other's agents.
  await alpha.run("whoami", "--as", "alice");
  await beta.run("whoami", "--as", "bob");
  await until(async () => (await alpha.run("peers")).stdout.includes("bob@beta"), "alpha to list bob@beta");
  await until(async () => (await beta.run("peers")).stdout.includes("alice@alpha"), "beta to list alice@alpha");

  // A message crosses, and so does the reply.
  const sent = await alpha.json<{ id: string; recipient: string }>(
    "send",
    "bob@beta",
    "hello across devices",
    "--as",
    "alice",
  );
  expect(sent.recipient).toBe("remote");
  const inbox = await until(async () => {
    const messages = await beta.json<{ id: string; from: string; body: string }[]>("inbox", "--as", "bob");
    return messages.length && messages;
  }, "bob to receive the message");
  expect(inbox).toMatchObject([{ id: sent.id, from: "alice@alpha", body: "hello across devices" }]);

  await beta.run("send", "alice@alpha", "got it", "--as", "bob", "--reply-to", sent.id);
  const reply = await until(async () => {
    const messages = await alpha.json<{ replyTo: string; body: string }[]>("inbox", "--as", "alice");
    return messages.length && messages;
  }, "alice to receive the reply");
  expect(reply).toMatchObject([{ replyTo: sent.id, body: "got it" }]);

  // Unknown agents and devices are refused at the sender.
  expect((await alpha.run("send", "nobody@beta", "hi", "--as", "alice")).stderr).toContain(
    'No agent named "nobody" on beta',
  );
  expect((await alpha.run("send", "bob@gamma", "hi", "--as", "alice")).stderr).toContain('No device named "gamma"');

  // The relay holds a message while the recipient's device is away.
  await beta.run("node", "stop");
  await until(async () => {
    const status = await alpha.status();
    return status.state === "joined" && status.devices.some((d) => d.name === "beta" && !d.online);
  }, "alpha to see beta offline");
  await alpha.run("send", "bob@beta", "while you were out", "--as", "alice");
  await until(async () => {
    const status = await alpha.status();
    return status.state === "joined" && status.pending === 0;
  }, "the relay to accept the message");
  const late = await until(async () => {
    const messages = await beta.json<{ body: string }[]>("inbox", "--as", "bob");
    return messages.length && messages;
  }, "bob to receive the held message after restarting");
  expect(late).toMatchObject([{ body: "while you were out" }]);

  // A revoked device is cut off and says so.
  expect((await alpha.run("devices", "revoke", "beta")).code).toBe(0);
  const stopped = await until(async () => {
    const status = await beta.status();
    return status.state === "stopped" && status;
  }, "beta to learn it was removed");
  expect(stopped.reason).toContain("removed from the network");
  expect((await alpha.run("send", "bob@beta", "anyone?", "--as", "alice")).stderr).toContain('No device named "beta"');
}, 120_000);
