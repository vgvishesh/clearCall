/** Small pure formatting helpers shared by screens. */

/** "0:07", "12:04", "1:02:03". Negative/NaN → "0:00". */
export function formatDuration(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Spoken form for screen readers: "1 hour 2 minutes 3 seconds". */
export function describeDuration(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const parts: string[] = [];
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) parts.push(`${h} ${h === 1 ? "hour" : "hours"}`);
  if (m) parts.push(`${m} ${m === 1 ? "minute" : "minutes"}`);
  if (s || parts.length === 0) parts.push(`${s} ${s === 1 ? "second" : "seconds"}`);
  return parts.join(" ");
}

export function displayName(name: string | null | undefined): string {
  const n = (name ?? "").trim();
  return n || "Guest";
}

/** First visible character (grapheme-aware where Intl.Segmenter exists), upper-cased. */
export function initialOf(name: string | null | undefined): string {
  const n = displayName(name);
  const Seg = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  const first = Seg
    ? (new Seg(undefined, { granularity: "grapheme" }).segment(n)[Symbol.iterator]().next().value?.segment ??
      n[0])
    : n[0];
  return (first ?? "G").toLocaleUpperCase();
}
