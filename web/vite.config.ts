import preact from "@preact/preset-vite";
import { VitePWA } from "vite-plugin-pwa";
import { defineConfig } from "vitest/config";
import { manifest, workbox } from "./src/ui/pwa/manifest.ts";

export default defineConfig({
  plugins: [
    preact(),
    VitePWA({
      registerType: "autoUpdate",
      // External /registerSW.js (no inline script → CSP script-src 'self'; nothing added to the entry chunk).
      // Version-mismatch "Reload" lives in src/ui/pwa/update.ts.
      injectRegister: "script-defer",
      includeAssets: ["favicon.ico", "logo.svg", "apple-touch-icon-180x180.png"],
      manifest,
      workbox,
      devOptions: { enabled: false },
    }),
  ],
  build: { target: "es2022", sourcemap: true, manifest: true },
  test: { environment: "happy-dom", include: ["src/**/*.test.{ts,tsx}"] },
});
