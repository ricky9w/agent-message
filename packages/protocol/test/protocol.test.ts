import { expect, test } from "bun:test";
import {
  applyEntry,
  canonical,
  createEntry,
  createIdentity,
  type Envelope,
  findDevice,
  normalizePairingCode,
  openEnvelope,
  type Payload,
  pairingCode,
  parseAddress,
  sealEnvelope,
  signRequest,
  toName,
  verifyRequest,
  verifyRoster,
} from "../src/index.ts";

const payload: Payload = {
  type: "message",
  message: { id: "m1", from: "a@one", to: "b@two", body: "hi 你好", sentAt: 1 },
};

test("addresses", () => {
  expect(parseAddress("bob")).toEqual({ agent: "bob" });
  expect(parseAddress("bob@mini")).toEqual({ agent: "bob", device: "mini" });
  for (const bad of ["", "Bob", "bob@", "a@b@c", "-x", "a b"]) expect(() => parseAddress(bad)).toThrow();
  expect(toName("Alice's MacBook Pro.local")).toBe("alice-s-macbook-pro.local");
  expect(toName("__")).toBe("");
});

test("canonical JSON sorts keys and drops undefined", () => {
  expect(canonical({ b: 1, a: [{ d: undefined, c: "x" }] })).toBe('{"a":[{"c":"x"}],"b":1}');
});

test("pairing code is a readable prefix of the device id", async () => {
  const { device } = await createIdentity("one");
  expect(device.id).toHaveLength(32);
  expect(pairingCode(device.id)).toMatch(/^[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{4}$/);
  expect(device.id.startsWith(normalizePairingCode(pairingCode(device.id).toUpperCase()))).toBe(true);
});

test("envelope round trip, and rejection of tampering and wrong parties", async () => {
  const [one, two, three] = await Promise.all(["one", "two", "three"].map(createIdentity));
  const envelope = await sealEnvelope(payload, one!, two!.device, { id: "e1", expires: 10 });
  expect(await openEnvelope(envelope, two!, one!.device)).toEqual(payload);
  expect(envelope.box).not.toContain("hi");

  const tampered: Envelope[] = [
    { ...envelope, expires: 11 },
    { ...envelope, id: "e2" },
    { ...envelope, ephemeral: true },
  ];
  for (const bad of tampered) await expect(openEnvelope(bad, two!, one!.device)).rejects.toThrow();
  // Not the recipient.
  await expect(openEnvelope({ ...envelope, to: three!.device.id }, three!, one!.device)).rejects.toThrow();
  // Sealed by someone else claiming to be `one`.
  const forged = await sealEnvelope(payload, { device: one!.device, secret: three!.secret }, two!.device, {
    id: "e3",
    expires: 10,
  });
  await expect(openEnvelope(forged, two!, one!.device)).rejects.toThrow("signature");
});

test("roster: founding, adding, revoking", async () => {
  const [one, two, three] = await Promise.all(["one", "two", "three"].map(createIdentity));
  const genesis = await createEntry(undefined, "add", one!.device, one!, 1);
  let roster = await applyEntry(undefined, genesis);
  expect(roster.network).toHaveLength(26);

  const addTwo = await createEntry(roster, "add", two!.device, one!, 2);
  roster = await applyEntry(roster, addTwo);
  const revokeOne = await createEntry(roster, "revoke", { id: one!.device.id }, two!, 3);
  roster = await applyEntry(roster, revokeOne);
  expect([...roster.devices.keys()]).toEqual([two!.device.id]);
  expect(findDevice(roster, "two")?.id).toBe(two!.device.id);

  const replayed = await verifyRoster([genesis, addTwo, revokeOne]);
  expect(replayed.head).toBe(roster.head);
  expect(replayed.network).toBe(roster.network);

  // A revoked device can neither sign nor come back; a stranger cannot sign; names are unique.
  await expect(applyEntry(roster, await createEntry(roster, "add", three!.device, one!, 4))).rejects.toThrow("member");
  await expect(applyEntry(roster, await createEntry(roster, "add", one!.device, two!, 4))).rejects.toThrow("already");
  await expect(applyEntry(roster, await createEntry(roster, "add", three!.device, three!, 4))).rejects.toThrow(
    "member",
  );
  const twin = await createIdentity("two");
  await expect(applyEntry(roster, await createEntry(roster, "add", twin.device, two!, 4))).rejects.toThrow("taken");
  // Entries cannot be reordered or have their keys swapped.
  await expect(verifyRoster([genesis, revokeOne])).rejects.toThrow("head");
  await expect(
    applyEntry(undefined, { ...genesis, device: { ...one!.device, kexKey: two!.device.kexKey } }),
  ).rejects.toThrow("keys");
});

test("request signatures bind method, URL, body and time", async () => {
  const one = await createIdentity("one");
  const url = new URL("https://relay.example/v1/roster?after=2");
  const keyOf = (id: string) => (id === one.device.id ? one.device.signKey : undefined);
  const header = await signRequest(one, "POST", url, "{}", 1_000_000);

  expect(await verifyRequest(header, "POST", url, "{}", keyOf, 1_060_000)).toBe(one.device.id);
  await expect(verifyRequest(header, "GET", url, "{}", keyOf, 1_000_000)).rejects.toThrow();
  await expect(
    verifyRequest(header, "POST", new URL("https://evil.example/v1/roster?after=2"), "{}", keyOf, 1_000_000),
  ).rejects.toThrow();
  await expect(verifyRequest(header, "POST", url, "{ }", keyOf, 1_000_000)).rejects.toThrow();
  await expect(verifyRequest(header, "POST", url, "{}", keyOf, 1_000_000 + 121_000)).rejects.toThrow("range");
  await expect(verifyRequest(header, "POST", url, "{}", () => undefined, 1_000_000)).rejects.toThrow();
  await expect(verifyRequest(null, "POST", url, "{}", keyOf, 1_000_000)).rejects.toThrow("Missing");
});
