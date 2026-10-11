/** Web app manifest + service worker options for vite-plugin-pwa (imported by vite.config.ts, tested by vitest). */

export const THEME_COLOR = "#0b0d10";

export const manifest = {
  id: "/",
  name: "Clearcall",
  short_name: "Clearcall",
  description: "Crystal-clear calls. Just share a link.",
  start_url: "/",
  scope: "/",
  display: "standalone" as const,
  background_color: THEME_COLOR,
  theme_color: THEME_COLOR,
  lang: "en",
  categories: ["social", "communication"],
  icons: [
    { src: "pwa-64x64.png", sizes: "64x64", type: "image/png" },
    { src: "pwa-192x192.png", sizes: "192x192", type: "image/png" },
    { src: "pwa-512x512.png", sizes: "512x512", type: "image/png" },
    { src: "maskable-icon-512x512.png", sizes: "512x512", type: "image/png", purpose: "maskable" as const },
  ],
};

/** App shell only: never cache /api/*; any navigation (incl. /c#…) falls back to the cached index.html. */
export const workbox = {
  globPatterns: ["**/*.{js,css,html,svg,png,ico,webmanifest}"],
  navigateFallback: "/index.html",
  navigateFallbackDenylist: [/^\/api\//],
  runtimeCaching: [],
  cleanupOutdatedCaches: true,
  clientsClaim: true,
  skipWaiting: true,
};
