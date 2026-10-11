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
