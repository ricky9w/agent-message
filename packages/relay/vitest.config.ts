import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Wrangler reads required secrets from the environment, as it does for `wrangler dev`.
process.env.BOOTSTRAP_TOKEN ??= "test-bootstrap-token";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  test: { include: ["vitest/**/*.vitest.ts"] },
});
