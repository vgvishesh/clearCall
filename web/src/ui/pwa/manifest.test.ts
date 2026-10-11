// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { manifest, THEME_COLOR, workbox } from "./manifest.ts";

const publicDir = fileURLToPath(new URL("../../../public/", import.meta.url));

describe("web app manifest", () => {
  it("has the installability fields", () => {
    expect(manifest.name).toBe("Clearcall");
    expect(manifest.short_name).toBe("Clearcall");
    expect(manifest.display).toBe("standalone");
    expect(manifest.start_url).toBe("/");
    expect(manifest.scope).toBe("/");
    expect(manifest.background_color).toBe("#0b0d10");
    expect(manifest.theme_color).toBe(THEME_COLOR);
  });

  it("ships 192, 512 and maskable icons that exist in public/", () => {
    const sizes = manifest.icons.map((i) => i.sizes);
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");
    expect(manifest.icons.some((i) => "purpose" in i && i.purpose === "maskable")).toBe(true);
    for (const icon of manifest.icons) expect(existsSync(publicDir + icon.src), icon.src).toBe(true);
    expect(existsSync(`${publicDir}apple-touch-icon-180x180.png`)).toBe(true);
    expect(existsSync(`${publicDir}logo.svg`)).toBe(true);
  });

  it("service worker caches the app shell only, never /api", () => {
    expect(workbox.navigateFallback).toBe("/index.html");
    expect(workbox.navigateFallbackDenylist.some((re) => re.test("/api/room/x"))).toBe(true);
    expect(workbox.runtimeCaching).toEqual([]);
  });
});

describe("_headers", () => {
  const headers = readFileSync(`${publicDir}_headers`, "utf8");
  it("sets a strict CSP that forbids framing", () => {
    const csp = headers.match(/Content-Security-Policy: (.*)/)?.[1] ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toMatch(/connect-src 'self' wss:/);
  });
  it("limits powerful features", () => {
    expect(headers).toMatch(/Permissions-Policy: camera=\(self\), microphone=\(self\), display-capture=\(\)/);
    expect(headers).toContain("Referrer-Policy: no-referrer");
  });
});
