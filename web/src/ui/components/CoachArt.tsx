/**
 * Inline-SVG pictures for the permission coach: the browser's own question with Allow highlighted, small glyphs of
 * the thing to tap in each step, and the "⋯ › Open in Safari" menu of in-app browsers. No image files, no deps.
 * Colors come from tokens via classes in app.css. All decorative (aria-hidden) unless given a label.
 */
import type { JSX } from "preact";
import type { Glyph, PromptLook } from "../copy.ts";
import { Svg } from "../icons.tsx";

const W = 280;

/** Picture of the browser's camera/mic question with the Allow button ringed. */
export function PromptPicture({ look, label }: { look: PromptLook; label: string }) {
  const pad = 22;
  const inner = W - 2 * pad;
  let h: number;
  let buttons: JSX.Element[];
  if (look.layout === "row") {
    h = 136;
    const n = look.buttons.length;
    const bw = (inner - 8 * (n - 1)) / n;
    buttons = look.buttons.map((b, i) => {
      const x = pad + i * (bw + 8);
      return <PromptButton key={b} x={x} y={86} w={bw} label={b} allow={i === look.allow} />;
    });
  } else {
    h = 40 + look.buttons.length * 40 + 14;
    buttons = look.buttons.map((b, i) => (
      <PromptButton key={b} x={pad} y={48 + i * 40} w={inner} label={b} allow={i === look.allow} />
    ));
  }
  return (
    <svg class="coach-art" viewBox={`0 0 ${W} ${h + 8}`} role="img" aria-label={label} focusable="false">
      <rect class="coach-art__dialog" x="8" y="6" width={W - 16} height={h - 4} rx="18" />
      {look.layout === "row" ? (
        <>
          <rect class="coach-art__line" x="64" y="30" width="152" height="10" rx="5" />
          <rect class="coach-art__line coach-art__line--soft" x="88" y="50" width="104" height="10" rx="5" />
        </>
      ) : (
        <>
          <circle class="coach-art__line" cx="34" cy="28" r="9" />
          <rect class="coach-art__line" x="52" y="23" width="150" height="10" rx="5" />
        </>
      )}
      {buttons}
    </svg>
  );
}

function PromptButton(props: { x: number; y: number; w: number; label: string; allow: boolean }) {
  const { x, y, w, label, allow } = props;
  return (
    <g>
      {allow && <rect class="coach-art__ring" x={x - 4} y={y - 4} width={w + 8} height={38} rx="19" />}
      <rect
        class={allow ? "coach-art__allow" : "coach-art__button"}
        x={x}
        y={y}
        width={w}
        height={30}
        rx="15"
      />
      <text
        class={allow ? "coach-art__allow-text" : "coach-art__button-text"}
        x={x + w / 2}
        y={y + 20}
        text-anchor="middle"
      >
        {label}
      </text>
      {allow && (
        <g class="coach-art__tap">
          <circle cx={x + w - 14} cy={y + 26} r="10" class="coach-art__tap-halo" />
          <circle cx={x + w - 14} cy={y + 26} r="4.5" class="coach-art__tap-dot" />
        </g>
      )}
    </g>
  );
}

/** In-app browser on iOS: the "⋯" menu with "Open in Safari" highlighted. */
export function InAppMenuPicture({ browser, label }: { browser: string; label: string }) {
  return (
    <svg class="coach-art" viewBox="0 0 280 150" role="img" aria-label={label} focusable="false">
      <rect class="coach-art__dialog" x="8" y="6" width="264" height="38" rx="12" />
      <rect class="coach-art__line coach-art__line--soft" x="22" y="20" width="120" height="10" rx="5" />
      <circle class="coach-art__ring" cx="246" cy="25" r="15" />
      <circle class="coach-art__allow" cx="246" cy="25" r="11" />
      <text class="coach-art__allow-text" x="246" y="29.5" text-anchor="middle">
        ⋯
      </text>
      <rect class="coach-art__dialog" x="96" y="52" width="176" height="92" rx="14" />
      <rect class="coach-art__line coach-art__line--soft" x="110" y="68" width="90" height="9" rx="4.5" />
      <rect class="coach-art__ring" x="100" y="96" width="168" height="40" rx="12" />
      <rect class="coach-art__allow" x="104" y="100" width="160" height="32" rx="10" />
      <text class="coach-art__allow-text" x="184" y="121" text-anchor="middle">
        Open in {browser}
      </text>
    </svg>
  );
}

/** Small picture of the thing to tap in a step. */
export function StepGlyph({ glyph }: { glyph: Glyph }) {
  if (glyph === "aa")
    return (
      <svg class="icon" width={28} height={28} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <text x="2" y="17" class="coach-glyph__text" font-size="10">
          a
        </text>
        <text x="8.5" y="18" class="coach-glyph__text" font-size="15">
          A
        </text>
      </svg>
    );
  if (glyph === "switch")
    return (
      <svg class="icon" width={28} height={28} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <rect x="1.5" y="6.5" width="21" height="11" rx="5.5" class="coach-glyph__switch" />
        <circle cx="17" cy="12" r="3.8" class="coach-glyph__knob" />
      </svg>
    );
  return <Svg size={28}>{GLYPH_PATHS[glyph]}</Svg>;
}

const GLYPH_PATHS: Record<Exclude<Glyph, "aa" | "switch">, JSX.Element> = {
  tune: (
    <>
      <path d="M4 8h8M18 8h2M4 16h2M12 16h8" />
      <circle cx="15" cy="8" r="2.5" />
      <circle cx="9" cy="16" r="2.5" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="10.5" width="14" height="10" rx="2.5" />
      <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
    </>
  ),
  gear: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7" />
      <circle cx="12" cy="12" r="6.5" />
    </>
  ),
  app: (
    <>
      <rect x="3.5" y="3.5" width="17" height="17" rx="4.5" />
      <path d="m9 15 1.8-4.2L15 9l-1.8 4.2z" />
    </>
  ),
  devices: (
    <>
      <rect x="2.5" y="7" width="11" height="10" rx="2.5" />
      <path d="m13.5 10.5 3.5-2v7l-3.5-2" />
      <rect x="18.5" y="4" width="3" height="7" rx="1.5" />
      <path d="M17.5 13.5a2.5 2.5 0 0 0 5 0M20 16v3" />
    </>
  ),
  menu: (
    <>
      <rect x="2.5" y="4" width="19" height="16" rx="3" />
      <path d="M2.5 8.5h19M6 6.3h3" />
    </>
  ),
  back: <path d="M9 13 4.5 8.5 9 4M4.5 8.5H14a5.5 5.5 0 0 1 0 11h-3" />,
  "cam-blocked": (
    <>
      <path d="M10 6h3a3 3 0 0 1 3 3v3.5m0 3.5a3 3 0 0 1-3 2H6a3 3 0 0 1-3-3V9a3 3 0 0 1 2-2.8" />
      <path d="m16 10.5 5-3v9l-3.2-1.9M3 3l18 18" />
    </>
  ),
  cross: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m9 9 6 6M15 9l-6 6" />
    </>
  ),
};
