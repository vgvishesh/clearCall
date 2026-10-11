import { useEffect, useState } from "preact/hooks";
import type { Size } from "./layout.ts";

/** Layout viewport size, updated on resize/rotation. */
export function useViewport(): Size {
  const read = () => ({ w: window.innerWidth, h: window.innerHeight });
  const [size, setSize] = useState<Size>(read);
  useEffect(() => {
    let raf = 0;
    const onResize = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setSize(read()));
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
    };
  }, []);
  return size;
}

/** Border-box height of an element, tracked with ResizeObserver. */
export function useHeight(el: HTMLElement | null): number {
  const [h, setH] = useState(0);
  useEffect(() => {
    if (!el) return;
    setH(el.getBoundingClientRect().height);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setH(el.getBoundingClientRect().height));
    // border-box: safe-area padding changes (rotation, standalone mode) must re-measure too.
    ro.observe(el, { box: "border-box" });
    return () => ro.disconnect();
  }, [el]);
  return h;
}

/** Re-render every `ms` (call timer). */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
