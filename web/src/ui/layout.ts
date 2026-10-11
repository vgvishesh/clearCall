/**
 * Call-screen layout: pure geometry. Every tile is absolutely positioned from these rects so video elements
 * never re-mount when the layout changes (1 → 2 → 4 → 10 people, rotation, active speaker).
 *
 * - solo (1):   self fills the screen.
 * - pair (2):   remote fills the screen; self is a picture-in-picture in a corner, clear of header/controls.
 * - grid (3–4): 2×2 (3 on portrait: the first remote spans the top row; on landscape: last row centered).
 * - grid (5–10) on narrow screens: best-fit columns, last row centered.
 *   Portrait, when self would sit alone in the last row (e.g. 10 people on a 393×659 phone: 3×3 + 1), self is
 *   docked instead as a small portrait thumbnail in the header row (top right, level with the status pill) and the
 *   remotes get a full grid below it: every remote tile grows and nothing floats over a face.
 * - spotlight (5–10) on wide screens: the active speaker large, everybody else in a side grid.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Size {
  w: number;
  h: number;
}

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export type Corner = "tl" | "tr" | "bl" | "br";
export type LayoutKind = "solo" | "pair" | "grid" | "spotlight";

export interface LayoutInput {
  /** Remote participant ids in display order. */
  remoteIds: string[];
  selfId: string;
  /** Full screen size (CSS px). */
  screen: Size;
  /** Space reserved for header (top) and controls (bottom) plus safe areas. */
  insets: Insets;
  /** Remote id shown large in spotlight mode. */
  spotlightId?: string | null;
  pipCorner?: Corner;
  gap?: number;
  /**
   * Height of the header's content row (status pill + its bottom padding) at the bottom of `insets.top`.
   * A docked self tile starts this far above `insets.top`, level with the pill. Default 48.
   */
  headerRow?: number;
}

export interface Layout {
  kind: LayoutKind;
  rects: Record<string, Rect>;
  /** Id rendered as a floating picture-in-picture (pair mode), else null. */
  pipId: string | null;
  /** Id of the full-bleed tile (solo/pair), else null. */
  fullBleedId: string | null;
  /** Id docked as a thumbnail in the header row (portrait grids where self would be alone in the last row). */
  dockId?: string | null;
}

export const WIDE_MIN_WIDTH = 900;

export function computeLayout(input: LayoutInput): Layout {
  const { remoteIds, selfId, screen, insets } = input;
  const gap = input.gap ?? 8;
  const n = remoteIds.length + 1;
  const full: Rect = { x: 0, y: 0, w: screen.w, h: screen.h };

  if (n === 1) return { kind: "solo", rects: { [selfId]: full }, pipId: null, fullBleedId: selfId };

  if (n === 2) {
    const remote = remoteIds[0]!;
    return {
      kind: "pair",
      rects: { [remote]: full, [selfId]: pipRect(screen, insets, input.pipCorner ?? "tr") },
      pipId: selfId,
      fullBleedId: remote,
    };
  }

  const area: Rect = {
    x: insets.left + gap,
    y: insets.top,
    w: Math.max(0, screen.w - insets.left - insets.right - gap * 2),
    h: Math.max(0, screen.h - insets.top - insets.bottom),
  };
  const ids = [...remoteIds, selfId];
  const landscape = area.w >= area.h;

  if (n >= 5 && screen.w >= WIDE_MIN_WIDTH && landscape) {
    const main =
      input.spotlightId && remoteIds.includes(input.spotlightId) ? input.spotlightId : remoteIds[0]!;
    const others = ids.filter((id) => id !== main);
    const sideW = Math.round(Math.min(Math.max(area.w * 0.3, 260), 440));
    const mainRect: Rect = { x: area.x, y: area.y, w: area.w - sideW - gap, h: area.h };
    const side: Rect = { x: area.x + mainRect.w + gap, y: area.y, w: sideW, h: area.h };
    const sideCols = bestColumns(others.length, side, gap, 16 / 9);
    return {
      kind: "spotlight",
      rects: { [main]: mainRect, ...gridRects(others, side, sideCols, gap, false) },
      pipId: null,
      fullBleedId: null,
    };
  }

  if (n <= 4) {
    if (n === 3 && !landscape) {
      // Portrait 3: the first remote gets the whole top row; the second remote and self share the bottom row.
      const rowH = (area.h - gap) / 2;
      const halfW = (area.w - gap) / 2;
      return {
        kind: "grid",
        rects: {
          [ids[0]!]: { x: area.x, y: area.y, w: area.w, h: rowH },
          [ids[1]!]: { x: area.x, y: area.y + rowH + gap, w: halfW, h: rowH },
          [ids[2]!]: { x: area.x + halfW + gap, y: area.y + rowH + gap, w: halfW, h: rowH },
        },
        pipId: null,
        fullBleedId: null,
      };
    }
    return { kind: "grid", rects: gridRects(ids, area, 2, gap, true), pipId: null, fullBleedId: null };
  }

  const cols = bestColumns(n, area, gap, landscape ? 4 / 3 : 1);
  if (!landscape && cols > 1 && (n - 1) % cols === 0) {
    const w = clamp(Math.round(area.w * 0.17), 60, 96);
    const h = Math.round((w * 4) / 3);
    const dock: Rect = { x: area.x + area.w - w, y: Math.max(0, insets.top - (input.headerRow ?? 48)), w, h };
    const top = dock.y + h + gap;
    const below: Rect = { x: area.x, y: top, w: area.w, h: area.y + area.h - top };
    const rcols = bestColumns(remoteIds.length, below, gap, 1);
    return {
      kind: "grid",
      rects: { ...gridRects(remoteIds, below, rcols, gap, true), [selfId]: dock },
      pipId: null,
      fullBleedId: null,
      dockId: selfId,
    };
  }
  return { kind: "grid", rects: gridRects(ids, area, cols, gap, true), pipId: null, fullBleedId: null };
}

/** Columns that maximise the visible area of a `ratio`-shaped picture fitted in each cell. */
export function bestColumns(n: number, area: Size, gap: number, ratio: number): number {
  let best = 1;
  let bestScore = -1;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    // Skip shapes that leave a whole empty row.
    if ((rows - 1) * cols >= n) continue;
    const cw = (area.w - gap * (cols - 1)) / cols;
    const ch = (area.h - gap * (rows - 1)) / rows;
    if (cw <= 0 || ch <= 0) continue;
    const fitW = Math.min(cw, ch * ratio);
    const fitH = fitW / ratio;
    // Prefer full grids: an empty cell costs area (√ of the fill ratio).
    const score = fitW * fitH * Math.sqrt(n / (rows * cols));
    if (score > bestScore + 0.5) {
      bestScore = score;
      best = cols;
    }
  }
  return best;
}

function gridRects(ids: string[], area: Rect, cols: number, gap: number, centerLast: boolean) {
  const rows = Math.max(1, Math.ceil(ids.length / cols));
  const cw = (area.w - gap * (cols - 1)) / cols;
  const ch = (area.h - gap * (rows - 1)) / rows;
  const rects: Record<string, Rect> = {};
  ids.forEach((id, i) => {
    const row = Math.floor(i / cols);
    const col = i % cols;
    const inRow = row === rows - 1 ? ids.length - row * cols : cols;
    const offset = centerLast && inRow < cols ? ((cols - inRow) * (cw + gap)) / 2 : 0;
    rects[id] = { x: area.x + offset + col * (cw + gap), y: area.y + row * (ch + gap), w: cw, h: ch };
  });
  return rects;
}

/** Self-view PiP in pair mode: small, in a corner, clear of the header and the controls. */
export function pipRect(screen: Size, insets: Insets, corner: Corner): Rect {
  const margin = 12;
  const portrait = screen.h >= screen.w;
  let w: number;
  let h: number;
  if (portrait) {
    w = clamp(Math.round(screen.w * 0.28), 96, 180);
    h = Math.round((w * 4) / 3);
  } else {
    h = clamp(Math.round(screen.h * 0.24), 90, 220);
    w = Math.round((h * 4) / 3);
  }
  const left = insets.left + margin;
  const right = screen.w - insets.right - margin - w;
  const top = insets.top + margin;
  const bottom = screen.h - insets.bottom - margin - h;
  return {
    x: corner === "tl" || corner === "bl" ? left : right,
    y: corner === "tl" || corner === "tr" ? top : bottom,
    w,
    h,
  };
}

/** The corner whose quadrant contains the point. */
export function nearestCorner(screen: Size, x: number, y: number): Corner {
  const v = y < screen.h / 2 ? "t" : "b";
  const h = x < screen.w / 2 ? "l" : "r";
  return `${v}${h}` as Corner;
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}
