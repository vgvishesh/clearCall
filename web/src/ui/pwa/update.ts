/**
 * Service worker updates. Registration is done by the plugin-generated external `/registerSW.js`
 * (injectRegister: "script-defer" — no inline script, CSP `script-src 'self'`). The SW uses
 * skipWaiting + clientsClaim (registerType "autoUpdate"), so a new version takes over as soon as it is installed;
 * we never force a reload ourselves while someone may be in a call.
 *
 * `reloadApp()` is the version-mismatch "Reload": fetch the newest SW, wait (briefly) for it to take control,
 * then reload into the new version. Equivalent to vite-plugin-pwa's `updateSW(true)` without pulling
 * workbox-window into the bundle.
 */
export async function reloadApp(): Promise<void> {
  const sw = "serviceWorker" in navigator ? navigator.serviceWorker : null;
  if (!sw) return location.reload();
  try {
    const reg = await sw.getRegistration();
    if (!reg) return location.reload();
    await reg.update();
    if (reg.installing || reg.waiting) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 4000);
        sw.addEventListener(
          "controllerchange",
          () => {
            clearTimeout(t);
            resolve();
          },
          { once: true },
        );
        reg.waiting?.postMessage({ type: "SKIP_WAITING" });
      });
    }
  } catch {
    // Offline or blocked: a plain reload is still the best we can do.
  }
  location.reload();
}
