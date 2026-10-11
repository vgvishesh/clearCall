/**
 * Icon generation from the SVG mark (public/logo.svg). Regenerate after changing the mark:
 *   cd web && pnpm exec pwa-assets-generator --config src/ui/pwa/pwa-assets.config.ts
 * Outputs (committed): public/pwa-64x64.png, pwa-192x192.png, pwa-512x512.png, maskable-icon-512x512.png,
 * apple-touch-icon-180x180.png, favicon.ico.
 */
import { defineConfig, minimal2023Preset } from "@vite-pwa/assets-generator/config";

const MARK_BG = "#14171c";

export default defineConfig({
  headLinkOptions: { preset: "2023" },
  preset: {
    ...minimal2023Preset,
    maskable: { ...minimal2023Preset.maskable, padding: 0.08, resizeOptions: { background: MARK_BG } },
    apple: { ...minimal2023Preset.apple, padding: 0.08, resizeOptions: { background: MARK_BG } },
  },
  images: ["public/logo.svg"],
});
