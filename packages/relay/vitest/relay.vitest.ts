import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import {
  AUTH_SKEW_MS,
  applyEntry,
  CLOSE_REVOKED,
  CLOSE_SUPERSEDED,
  createEntry,
  createIdentity,
  type Identity,
  MAX_ENVELOPE_BYTES,
  MESSAGE_TTL_MS,
  openEnvelope,
  PAIRING_TTL_MS,
  pairingCode,
} from "@agent-message/protocol";
import { describe, expect, test } from "vitest";
import { call, freshRelay, init, Network, Socket, type Stub, seal, sql } from "./helpers.ts";

const pair = (stub: Stub, identity: Identity, as: Identity = identity) =>
  call(stub, "POST", "/v1/pair", { as, body: { device: identity.device } });

describe("init", () => {
  test("the worker routes to the relay object", async () => {
    const response = await exports.default.fetch("https://relay.test/v1");
    expect(await response.json()).toEqual({ protocol: 1, network: null });
  });

  test("founds the network once, with the bootstrap token", async () => {
    const stub = freshRelay();
    const one = await createIdentity("one");
    const genesis = await createEntry(undefined, "add", one.device, one, Date.now());
    const roster = await applyEntry(undefined, genesis);

    const wrongToken = { body: { entry: genesis }, headers: { Authorization: "Bearer nope" } };
    expect((await call(stub, "POST", "/v1/init", { body: { entry: genesis } })).status).toBe(401);
    expect((await call(stub, "POST", "/v1/init", wrongToken)).status).toBe(401);

    const response = await init(stub, genesis);
    expect(response.status).toBe(201);
    expect(response.body).toEqual({ network: roster.network });
    expect((await call(stub, "GET", "/v1")).body).toEqual({ protocol: 1, network: roster.network });

    const again = await init(stub, await createEntry(undefined, "add", (await createIdentity("two")).device, one, 1));
    expect(again.status).toBe(409);
  });

  test("rejects malformed and invalid founding entries", async () => {
    const stub = freshRelay();
    const [one, two] = await Promise.all(["one", "two"].map(createIdentity));
    const genesis = await createEntry(undefined, "add", one!.device, one!, Date.now());

    expect((await init(stub, { ...genesis, action: "remove" } as never)).status).toBe(400);
    const signedByOther = await createEntry(undefined, "add", one!.device, two!, Date.now());
    const response = await init(stub, signedByOther);
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "Roster entry is not signed by a member" });
    expect((await call(stub, "GET", "/v1")).body).toEqual({ protocol: 1, network: null });
  });
});

describe("pairing", () => {
  test("a paired device is added, reads the roster and connects", async () => {
    const network = await Network.create(freshRelay(), "one");
    const { stub } = network;
    const [one] = network.devices;
    const two = await createIdentity("two");
    const [first] = await Socket.connect(stub, one!);

    expect((await pair(stub, two)).status).toBe(202);
    const code = pairingCode(two.device.id).toUpperCase();
    const found = await call(stub, "GET", `/v1/pair/${code}`, { as: one });
    expect(found.body).toEqual({ device: two.device });

    const added = await network.append("add", two.device);
    expect(added.body).toEqual({ roster: 2 });
    expect(await first.next()).toEqual({ t: "roster", roster: 2 });
    expect((await call(stub, "GET", `/v1/pair/${code}`, { as: one })).status).toBe(404);

    const roster = await call(stub, "GET", "/v1/roster?after=1", { as: two });
    const { entries } = roster.body as { entries: unknown[] };
    expect(entries).toHaveLength(1);
    expect(await applyEntry(network.roster, entries[0] as never).catch((error) => error)).toBeInstanceOf(Error);

    const [, hello] = await Socket.connect(stub, two);
    expect(hello).toEqual({ t: "hello", roster: 2, online: [one!.device.id] });
    expect((await pair(stub, two)).status).toBe(409);
  });

  test("rejects requests that are unsigned, misattributed or premature", async () => {
    const early = freshRelay();
    const two = await createIdentity("two");
    expect((await pair(early, two)).status).toBe(409);

    const { stub, devices } = await Network.create(freshRelay(), "one");
    const other = await createIdentity("other");
    expect((await call(stub, "POST", "/v1/pair", { body: { device: two.device } })).status).toBe(401);
    expect((await pair(stub, two, { device: two.device, secret: other.secret })).status).toBe(401);
    const forged = { ...two.device, kexKey: other.device.kexKey };
    expect((await pair(stub, { device: forged, secret: two.secret })).status).toBe(400);
    expect((await call(stub, "POST", "/v1/pair", { as: two, body: { device: "two" } })).status).toBe(400);
    expect((await pair(stub, devices[0]!)).status).toBe(409);
  });

  test("lookups need a member and a well-formed, matching code", async () => {
    const { stub, devices } = await Network.create(freshRelay(), "one");
    const two = await createIdentity("two");
    await pair(stub, two);
    const code = pairingCode(two.device.id);
    expect((await call(stub, "GET", `/v1/pair/${code}`, { as: two })).status).toBe(401);
    expect((await call(stub, "GET", `/v1/pair/${code.slice(0, -1)}`, { as: devices[0] })).status).toBe(400);
    const unknown = pairingCode((await createIdentity("three")).device.id);
    expect((await call(stub, "GET", `/v1/pair/${unknown}`, { as: devices[0] })).status).toBe(404);
  });

  test("at most eight requests wait at once, and repeating one refreshes it", async () => {
    const { stub } = await Network.create(freshRelay(), "one");
    const waiting = await Promise.all(Array.from({ length: 8 }, (_, i) => createIdentity(`d${i}`)));
    for (const identity of waiting) expect((await pair(stub, identity)).status).toBe(202);
    expect((await pair(stub, await createIdentity("late"))).status).toBe(429);

    const before = Date.now();
    expect((await pair(stub, waiting[0]!)).status).toBe(202);
    const after = Date.now();
    const [row] = await sql<{ expires: number }>(
      stub,
      "SELECT expires FROM pairing WHERE device_id = ?",
      waiting[0]!.device.id,
    );
    expect(row!.expires).toBeGreaterThanOrEqual(before + PAIRING_TTL_MS);
    expect(row!.expires).toBeLessThanOrEqual(after + PAIRING_TTL_MS);
  });

  test("expired requests are not found and are deleted by the alarm", async () => {
    const { stub, devices } = await Network.create(freshRelay(), "one");
    const [two, three] = await Promise.all(["two", "three"].map(createIdentity));
    await pair(stub, two!);
    await pair(stub, three!);
    await sql(stub, "UPDATE pairing SET expires = ? WHERE device_id = ?", Date.now() - 1, two!.device.id);

    const code = pairingCode(two!.device.id);
    expect((await call(stub, "GET", `/v1/pair/${code}`, { as: devices[0] })).status).toBe(404);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await sql(stub, "SELECT device_id FROM pairing")).toEqual([{ device_id: three!.device.id }]);
    // Re-armed for the request that is still waiting.
    expect(await runInDurableObject(stub, (_, state) => state.storage.getAlarm())).toBeTypeOf("number");
  });
});

describe("authentication", () => {
  test("rejects unsigned, forged, stale and revoked requests", async () => {
    const network = await Network.create(freshRelay(), "one", "two");
    const { stub } = network;
    const [one, two] = network.devices;
    const stranger = await createIdentity("stranger");

    expect((await call(stub, "GET", "/v1/roster")).status).toBe(401);
    expect(
      (await call(stub, "GET", "/v1/roster", { as: { device: one!.device, secret: stranger.secret } })).status,
    ).toBe(401);
    expect((await call(stub, "GET", "/v1/roster", { as: stranger })).status).toBe(401);
    const stale = await call(stub, "GET", "/v1/roster", { as: one, at: Date.now() - AUTH_SKEW_MS - 60_000 });
    expect(stale.status).toBe(401);
    expect(stale.body).toEqual({ error: "Request timestamp is out of range" });
    expect((await call(stub, "GET", "/v1/roster", { as: one })).status).toBe(200);

    expect((await network.append("revoke", { id: two!.device.id })).status).toBe(201);
    expect((await call(stub, "GET", "/v1/roster", { as: two })).status).toBe(401);
    expect((await call(stub, "GET", "/v1/connect", { as: two, headers: { Upgrade: "websocket" } })).status).toBe(401);
  });

  test("connect requires a WebSocket upgrade", async () => {
    const { stub, devices } = await Network.create(freshRelay(), "one");
    expect((await call(stub, "GET", "/v1/connect", { as: devices[0] })).status).toBe(426);
  });
});

describe("roster", () => {
  test("serves entries after an index", async () => {
    const network = await Network.create(freshRelay(), "one", "two", "three");
    const read = async (query: string) => {
      const response = await call(network.stub, "GET", `/v1/roster${query}`, { as: network.devices[1] });
      return response.status === 200 ? (response.body as { entries: unknown[] }).entries.length : response.status;
    };
    expect(await read("")).toBe(3);
    expect(await read("?after=2")).toBe(1);
    expect(await read("?after=3")).toBe(0);
    expect(await read("?after=-1")).toBe(400);
  });

  test("rejects entries that do not follow the head or are signed for someone else", async () => {
    const network = await Network.create(freshRelay(), "one", "two");
    const [one, two] = network.devices;
    const three = await createIdentity("three");

    const stale = await createEntry(undefined, "add", three.device, one!, Date.now());
    const response = await call(network.stub, "POST", "/v1/roster", { as: one, body: { entry: stale } });
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: "Roster entry does not follow the current head" });

    const entry = await createEntry(network.roster, "add", three.device, one!, Date.now());
    expect((await call(network.stub, "POST", "/v1/roster", { as: two, body: { entry } })).status).toBe(403);
    expect((await call(network.stub, "POST", "/v1/roster", { as: two, body: { entry: {} } })).status).toBe(400);
  });

  test("revoking closes the device's socket, purges its queue and announces the new length", async () => {
    const network = await Network.create(freshRelay(), "one", "two", "three");
    const { stub } = network;
    const [one, two, three] = network.devices;
    const [socketTwo] = await Socket.connect(stub, two!);
    socketTwo.send({ t: "send", envelope: await seal(two!, three!.device) });
    expect(await socketTwo.next()).toMatchObject({ t: "sent" });
    const [socketOne] = await Socket.connect(stub, one!);
    socketOne.send({ t: "send", envelope: await seal(one!, two!.device) });
    expect(await socketOne.next()).toMatchObject({ t: "sent" });
    expect(await socketTwo.next()).toMatchObject({ t: "presence", device: one!.device.id, online: true });
    expect(await socketTwo.next()).toMatchObject({ t: "deliver" });

    const revoked = await network.append("revoke", { id: two!.device.id });
    expect(revoked.body).toEqual({ roster: 4 });
    expect((await socketTwo.waitClosed()).code).toBe(CLOSE_REVOKED);
    expect(await socketOne.next()).toEqual({ t: "roster", roster: 4 });
    expect(await sql(stub, "SELECT id FROM queue")).toEqual([]);
  });
});

describe("messaging", () => {
  test("queued envelopes are delivered on connect, in order, until acknowledged", async () => {
    const { stub, devices } = await Network.create(freshRelay(), "one", "two");
    const [one, two] = devices;
    const [sender] = await Socket.connect(stub, one!);
    const first = await seal(one!, two!.device);
    const second = await seal(one!, two!.device);
    for (const envelope of [first, second, first]) {
      sender.send({ t: "send", envelope });
      expect(await sender.next()).toEqual({ t: "sent", id: envelope.id });
    }

    const [receiver, hello] = await Socket.connect(stub, two!);
    expect(hello).toEqual({ t: "hello", roster: 2, online: [one!.device.id] });
    expect(await receiver.next()).toEqual({ t: "deliver", envelope: first });
    expect(await receiver.next()).toEqual({ t: "deliver", envelope: second });
    expect(await openEnvelope(second, two!, one!.device)).toEqual({ type: "agents", agents: [], at: 0 });

    receiver.send({ t: "ack", id: first.id });
    receiver.ws.close(1000);
    // A connection after the ack gets only the unacknowledged envelope: delivery order puts `first` ahead of it.
    const [again] = await Socket.connect(stub, two!);
    expect(await again.next()).toEqual({ t: "deliver", envelope: second });
  });

  test("forwards live between connected devices", async () => {
    const { stub, devices } = await Network.create(freshRelay(), "one", "two");
    const [one, two] = devices;
    const [a] = await Socket.connect(stub, one!);
    const [b] = await Socket.connect(stub, two!);
    expect(await a.next()).toEqual({ t: "presence", device: two!.device.id, online: true });

    const envelope = await seal(one!, two!.device);
    a.send({ t: "send", envelope });
    expect(await a.next()).toEqual({ t: "sent", id: envelope.id });
    expect(await b.next()).toEqual({ t: "deliver", envelope });
    // Stored until acknowledged, in case the receiver drops before saving it.
    expect(await sql(stub, "SELECT id FROM queue")).toEqual([{ id: envelope.id }]);
    b.send({ t: "ack", id: envelope.id });
    b.send("ping");
    expect(await b.text()).toBe("pong");
    expect(await sql(stub, "SELECT id FROM queue")).toEqual([]);
  });

  test("ephemeral envelopes are forwarded when online and dropped otherwise", async () => {
    const { stub, devices } = await Network.create(freshRelay(), "one", "two");
    const [one, two] = devices;
    const [a] = await Socket.connect(stub, one!);

    const dropped = await seal(one!, two!.device, { ephemeral: true });
    const kept = await seal(one!, two!.device);
    for (const envelope of [dropped, kept]) {
      a.send({ t: "send", envelope });
      expect(await a.next()).toEqual({ t: "sent", id: envelope.id });
    }
    // Had `dropped` been queued, it would be delivered before `kept`.
    const [b] = await Socket.connect(stub, two!);
    expect(await b.next()).toEqual({ t: "deliver", envelope: kept });

    const live = await seal(one!, two!.device, { ephemeral: true });
    a.send({ t: "send", envelope: live });
    expect(await b.next()).toEqual({ t: "deliver", envelope: live });
    expect(await sql(stub, "SELECT id FROM queue")).toEqual([{ id: kept.id }]);
  });

  test("rejects envelopes it will never deliver", async () => {
    const { stub, devices } = await Network.create(freshRelay(), "one", "two");
    const [one, two] = devices;
    const stranger = await createIdentity("stranger");
    const [a] = await Socket.connect(stub, one!);
    const rejection = async (envelope: Awaited<ReturnType<typeof seal>>) => {
      a.send({ t: "send", envelope });
      const frame = await a.next();
      expect(frame).toMatchObject({ t: "rejected", id: envelope.id });
      return (frame as { reason: string }).reason;
    };

    const base = await seal(one!, two!.device);
    expect(await rejection({ ...base, box: "x".repeat(MAX_ENVELOPE_BYTES) })).toBe("envelope is too large");
    expect(await rejection(await seal(two!, one!.device))).toBe("envelope is not from the sending device");
    expect(await rejection(await seal(one!, stranger.device))).toBe("recipient is not a member");
    expect(await rejection(await seal(one!, one!.device))).toBe("recipient is not a member");
    expect(await rejection(await seal(one!, two!.device, { expires: Date.now() - 1 }))).toBe("envelope has expired");
    expect(await sql(stub, "SELECT id FROM queue")).toEqual([]);
  });

  test("caps storage time and drops envelopes when they expire", async () => {
    const { stub, devices } = await Network.create(freshRelay(), "one", "two");
    const [one, two] = devices;
    const [a] = await Socket.connect(stub, one!);
    const distant = await seal(one!, two!.device, { expires: Date.now() + 2 * MESSAGE_TTL_MS });
    const soon = await seal(one!, two!.device);

    const before = Date.now();
    a.send({ t: "send", envelope: distant });
    expect(await a.next()).toMatchObject({ t: "sent" });
    const after = Date.now();
    a.send({ t: "send", envelope: soon });
    expect(await a.next()).toMatchObject({ t: "sent" });
    const [stored] = await sql<{ expires: number }>(stub, "SELECT expires FROM queue WHERE id = ?", distant.id);
    expect(stored!.expires).toBeGreaterThanOrEqual(before + MESSAGE_TTL_MS);
    expect(stored!.expires).toBeLessThanOrEqual(after + MESSAGE_TTL_MS);

    await sql(stub, "UPDATE queue SET expires = ? WHERE id = ?", Date.now() - 1, soon.id);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await sql(stub, "SELECT id FROM queue")).toEqual([{ id: distant.id }]);
  });

  test("refuses to queue beyond its capacity", async () => {
    const { stub, devices } = await Network.create(freshRelay(), "one", "two");
    const [one, two] = devices;
    await sql(
      stub,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10000)
       INSERT INTO queue (sender, recipient, id, envelope, expires) SELECT ?, ?, 'filler' || i, '{}', ? FROM n`,
      one!.device.id,
      two!.device.id,
      Date.now() + 60_000,
    );
    const [a] = await Socket.connect(stub, one!);
    const envelope = await seal(one!, two!.device);
    a.send({ t: "send", envelope });
    expect(await a.next()).toEqual({ t: "rejected", id: envelope.id, reason: "relay queue is full" });
  });

  test("closes the socket on a malformed frame", async () => {
    const { stub, devices } = await Network.create(freshRelay(), "one");
    const [a] = await Socket.connect(stub, devices[0]!);
    a.send({ t: "send", envelope: { id: "x" } });
    expect((await a.waitClosed()).code).toBe(1003);
  });

  test("keeps working after the object is evicted", async () => {
    const { stub, devices } = await Network.create(freshRelay(), "one", "two");
    const [one, two] = devices;
    const [a] = await Socket.connect(stub, one!);
    const [b] = await Socket.connect(stub, two!);
    expect(await a.next()).toMatchObject({ t: "presence", online: true });

    await evictDurableObject(stub);
    const envelope = await seal(one!, two!.device);
    a.send({ t: "send", envelope });
    expect(await a.next()).toEqual({ t: "sent", id: envelope.id });
    expect(await b.next()).toEqual({ t: "deliver", envelope });
  });
});

describe("presence", () => {
  test("announces connections and disconnections to the other devices", async () => {
    const { stub, devices } = await Network.create(freshRelay(), "one", "two", "three");
    const [one, two, three] = devices;
    const [a, helloA] = await Socket.connect(stub, one!);
    expect(helloA.online).toEqual([]);
    const [b] = await Socket.connect(stub, two!);
    expect(await a.next()).toEqual({ t: "presence", device: two!.device.id, online: true });
    const [, helloC] = await Socket.connect(stub, three!);
    expect(helloC.online.toSorted()).toEqual([one!.device.id, two!.device.id].toSorted());
    expect(await a.next()).toEqual({ t: "presence", device: three!.device.id, online: true });

    b.ws.close(1000);
    expect(await a.next()).toEqual({ t: "presence", device: two!.device.id, online: false });
  });

  test("a new connection supersedes the old one without an offline announcement", async () => {
    const { stub, devices } = await Network.create(freshRelay(), "one", "two");
    const [one, two] = devices;
    const [observer] = await Socket.connect(stub, one!);
    const [first] = await Socket.connect(stub, two!);
    expect(await observer.next()).toEqual({ t: "presence", device: two!.device.id, online: true });

    const [second, hello] = await Socket.connect(stub, two!);
    expect(hello.online).toEqual([one!.device.id]);
    expect((await first.waitClosed()).code).toBe(CLOSE_SUPERSEDED);
    expect(await observer.next()).toEqual({ t: "presence", device: two!.device.id, online: true });

    // Wait until the relay has handled the old socket's close, then use a delivery as a marker:
    // an offline announcement for the old socket would arrive before it.
    await until(() => runInDurableObject(stub, (_, state) => state.getWebSockets(two!.device.id).length === 1));
    const envelope = await seal(two!, one!.device);
    second.send({ t: "send", envelope });
    expect(await observer.next()).toEqual({ t: "deliver", envelope });
  });
});

async function until(probe: () => Promise<boolean>): Promise<void> {
  const deadline = performance.now() + 4_000;
  while (!(await probe())) {
    if (performance.now() > deadline) throw new Error(`Timed out waiting for ${probe}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
