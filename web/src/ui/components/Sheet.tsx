import type { ComponentChildren } from "preact";
import { useEffect, useId, useRef } from "preact/hooks";
import { TID } from "../../core/testids.ts";
import { CloseIcon } from "../icons.tsx";

/** Bottom sheet (phone) / floating panel (desktop). Closes on backdrop tap and Escape; focus moves in and back. */
export function Sheet(props: { title: string; onClose: () => void; children: ComponentChildren }) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, []);
  return (
    <div class="sheet-layer">
      <button type="button" class="sheet-backdrop" aria-label="Close" tabIndex={-1} onClick={props.onClose} />
      <div class="sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={panel} tabIndex={-1}>
        <div class="sheet__head">
          <h2 class="sheet__title" id={titleId}>
            {props.title}
          </h2>
          <button
            type="button"
            class="icon-btn"
            data-testid={TID.sheetClose}
            aria-label="Close"
            onClick={props.onClose}
          >
            <CloseIcon size={20} />
          </button>
        </div>
        {props.children}
      </div>
    </div>
  );
}
