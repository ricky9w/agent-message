import { expect, test } from "bun:test";
import { createIdentity } from "@agent-message/protocol";
import { RelayLink, reconnectDelay, Stop } from "../src/link.ts";
import { until } from "./until.ts";

/** A link whose first connection attempt stays pending until the test decides how it ends. */
async function pendingLink() {
  let fail: (error: Error) => void = () => {};
  const stopped: string[] = [];
  const link = new RelayLink(
    new URL("http://localhost:1"),
    await createIdentity("mac"),
    {
      prepare: () =>
        new Promise((_, reject) => {
          fail = reject;
        }),
      frame: async () => {},
      disconnected: () => {},
      stopped: (reason) => void stopped.push(reason),
    },
    Date.now,
  );
  return { link, fail, stopped };
}

test("a link counts as connecting only until its first attempt has an outcome", async () => {
  const { link, fail } = await pendingLink();
  expect(link.connecting).toBe(true);
  expect(link.connected).toBe(false);

  fail(new Error("relay unreachable"));
  await until(() => !link.connecting, "the failed attempt to be recorded");
  expect(link.connected).toBe(false);
  link.close();
});

test("a link that the relay refuses for good stops and is no longer connecting", async () => {
  const { link, fail, stopped } = await pendingLink();
  fail(new Stop("removed"));
  await until(() => stopped.length, "the link to stop");
  expect(stopped).toEqual(["removed"]);
  expect(link.connecting).toBe(false);
});

test("reconnect delays double from a second to a minute, within 20%", () => {
  expect([0, 1, 2, 3].map((attempt) => reconnectDelay(attempt, 0.5))).toEqual([1000, 2000, 4000, 8000]);
  expect(reconnectDelay(20, 0.5)).toBe(60_000);
  expect(reconnectDelay(0, 0)).toBeCloseTo(800);
  expect(reconnectDelay(0, 1)).toBeCloseTo(1200);
});
