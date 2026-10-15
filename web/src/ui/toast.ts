import { signal } from "@preact/signals";

/** One transient, polite status message at a time ("Link copied"). */
export const toast = signal<{ id: number; text: string } | null>(null);

let seq = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

export function showToast(text: string, ms = 2400): void {
  const id = ++seq;
  toast.value = { id, text };
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (toast.peek()?.id === id) toast.value = null;
  }, ms);
}

/** Share the call link and confirm a clipboard fallback with a toast. */
export async function shareWithFeedback(share: () => Promise<"shared" | "copied" | "cancelled">) {
  try {
    const r = await share();
    if (r === "copied") showToast("Link copied");
  } catch {
    showToast("Couldn’t share the link");
  }
}

/** Copy a link to the clipboard (with an old-WebView fallback) and confirm with a toast. */
export async function copyWithFeedback(text: string, done = "Link copied"): Promise<boolean> {
  let ok: boolean;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    ok = legacyCopy(text);
  }
  showToast(ok ? done : "Couldn’t copy. Press and hold the web address to copy it.", 4000);
  return ok;
}

function legacyCopy(text: string): boolean {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
