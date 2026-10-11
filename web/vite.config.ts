import preact from "@preact/preset-vite";
import { defineConfig } from "vitest/config";

// PWA plugin (manifest + service worker) is configured by the UI/PWA work package.
export default defineConfig({
  plugins: [preact()],
  build: { target: "es2022", sourcemap: true },
  test: { environment: "happy-dom", include: ["src/**/*.test.{ts,tsx}"] },
});
