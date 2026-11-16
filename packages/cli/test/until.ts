/**
 * Returns the first truthy value of `probe`. The deadline is not what a test asserts: it only turns
 * a wait that would never end into a failure that says what was missing.
 */
export async function until<T>(probe: () => T | Promise<T>, what: string, ms = 20_000): Promise<NonNullable<T>> {
  const deadline = performance.now() + ms;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (performance.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
}
