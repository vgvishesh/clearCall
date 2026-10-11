import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // vitest-pool-workers 0.23 bundles workerd 2026-08-15, older than wrangler.jsonc's compatibility_date.
      miniflare: { compatibilityDate: "2026-08-15" },
    }),
  ],
  test: { include: ["test/**/*.test.ts"], testTimeout: 20_000 },
});
