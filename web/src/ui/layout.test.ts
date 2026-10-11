import { describe, expect, it } from "vitest";
import { bestColumns, computeLayout, type Insets, nearestCorner, pipRect, type Rect } from "./layout.ts";

const insets: Insets = { top: 60, right: 0, bottom: 100, left: 0 };
const phone = { w: 393, h: 852 };
const desktop = { w: 1440, h: 900 };
const ids = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`);

function overlaps(a: Rect, b: Rect) {
  return a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5;
}

function expectTiled(rects: Record<string, Rect>, screen: { w: number; h: number }) {
  const list = Object.values(rects);
  for (const r of list) {
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.y).toBeGreaterThanOrEqual(insets.top - 0.5);
    expect(r.x + r.w).toBeLessThanOrEqual(screen.w + 0.5);
    expect(r.y + r.h).toBeLessThanOrEqual(screen.h - insets.bottom + 0.5);
  }
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++) expect(overlaps(list[i]!, list[j]!)).toBe(false);
}

describe("computeLayout", () => {
  it("solo: self fills the screen", () => {
    const l = computeLayout({ remoteIds: [], selfId: "me", screen: phone, insets });
    expect(l.kind).toBe("solo");
    expect(l.rects.me).toEqual({ x: 0, y: 0, w: 393, h: 852 });
  });

  it("pair: remote full-bleed, self PiP in a corner clear of header, controls and the center", () => {
    const l = computeLayout({ remoteIds: ["a"], selfId: "me", screen: phone, insets });
    expect(l.kind).toBe("pair");
    expect(l.pipId).toBe("me");
    const pip = l.rects.me!;
    expect(pip.y).toBeGreaterThanOrEqual(insets.top);
    expect(pip.x + pip.w).toBeLessThanOrEqual(phone.w);
    // Never covers the center of the remote video.
    expect(pip.x).toBeGreaterThan(phone.w / 2);
    expect(pip.y + pip.h).toBeLessThan(phone.h / 2);
    const bl = computeLayout({ remoteIds: ["a"], selfId: "me", screen: phone, insets, pipCorner: "bl" }).rects
      .me!;
    expect(bl.y + bl.h).toBeLessThanOrEqual(phone.h - insets.bottom);
    expect(bl.x).toBeLessThan(phone.w / 2);
  });

  it.each([3, 4])("%i people: 2 columns, no overlaps, inside the stage", (n) => {
    for (const screen of [phone, desktop]) {
      const l = computeLayout({ remoteIds: ids(n - 1), selfId: "me", screen, insets });
      expect(l.kind).toBe("grid");
      expect(Object.keys(l.rects)).toHaveLength(n);
      expectTiled(l.rects, screen);
    }
  });

  it("portrait 3: first remote spans the top row", () => {
    const l = computeLayout({ remoteIds: ["a", "b"], selfId: "me", screen: phone, insets });
    expect(l.rects.a!.w).toBeGreaterThan(l.rects.b!.w * 1.9);
    expect(l.rects.b!.y).toBe(l.rects.me!.y);
  });

  it.each([5, 6, 7, 8, 9, 10])("%i people on a phone: grid, all tiles placed", (n) => {
    const l = computeLayout({ remoteIds: ids(n - 1), selfId: "me", screen: phone, insets });
    expect(l.kind).toBe("grid");
    expect(Object.keys(l.rects)).toHaveLength(n);
    // A docked self thumbnail lives in the header row; everything else tiles the stage.
    const { [l.dockId ?? ""]: dock, ...grid } = l.rects;
    expectTiled(grid, phone);
    if (dock) for (const r of Object.values(grid)) expect(overlaps(r, dock)).toBe(false);
  });

  it.each([10, 7, 5])(
    "%i people on a short phone: self docked in the header row, remotes in a full grid",
    (n) => {
      const screen = { w: 393, h: 659 };
      const l = computeLayout({ remoteIds: ids(n - 1), selfId: "me", screen, insets });
      expect(l.kind).toBe("grid");
      expect(l.dockId).toBe("me");
      const dock = l.rects.me!;
      // Level with the status pill, top right, portrait-shaped.
      expect(dock.y).toBe(insets.top - 48);
      expect(dock.x + dock.w).toBeGreaterThan(screen.w - 16);
      expect(dock.h).toBeGreaterThan(dock.w);
      const remotes = Object.fromEntries(Object.entries(l.rects).filter(([id]) => id !== "me"));
      expectTiled(remotes, screen);
      for (const r of Object.values(remotes)) {
        expect(overlaps(r, dock)).toBe(false);
        expect(r.w * r.h).toBeGreaterThan(dock.w * dock.h);
      }
      // No ragged last row: every remote row is full.
      const ys = new Set(Object.values(remotes).map((r) => r.y));
      const xs = new Set(Object.values(remotes).map((r) => r.x));
      expect(ys.size * xs.size).toBe(n - 1);
    },
  );

  it("10 people on a tall phone keeps self in the grid (2 × 5)", () => {
    const l = computeLayout({ remoteIds: ids(9), selfId: "me", screen: { w: 412, h: 915 }, insets });
    expect(l.dockId ?? null).toBeNull();
  });

  it.each([5, 10])("%i people on desktop: spotlight on the active speaker", (n) => {
    const remotes = ids(n - 1);
    const l = computeLayout({ remoteIds: remotes, selfId: "me", screen: desktop, insets, spotlightId: "p2" });
    expect(l.kind).toBe("spotlight");
    const main = l.rects.p2!;
    for (const [id, r] of Object.entries(l.rects))
      if (id !== "p2") expect(r.w * r.h).toBeLessThan(main.w * main.h);
    expectTiled(l.rects, desktop);
  });

  it("spotlight falls back to the first remote for unknown ids", () => {
    const l = computeLayout({
      remoteIds: ids(6),
      selfId: "me",
      screen: desktop,
      insets,
      spotlightId: "nope",
    });
    const biggest = Object.entries(l.rects).sort((a, b) => b[1].w * b[1].h - a[1].w * a[1].h)[0]![0];
    expect(biggest).toBe("p0");
  });
});

describe("helpers", () => {
  it("bestColumns prefers full grids", () => {
    expect(bestColumns(10, { w: 377, h: 620 }, 8, 1)).toBe(2);
    expect(bestColumns(9, { w: 377, h: 620 }, 8, 1)).toBe(3);
    expect(bestColumns(4, { w: 1400, h: 760 }, 8, 4 / 3)).toBe(2);
  });

  it("nearestCorner by quadrant", () => {
    expect(nearestCorner(phone, 10, 10)).toBe("tl");
    expect(nearestCorner(phone, 380, 10)).toBe("tr");
    expect(nearestCorner(phone, 10, 800)).toBe("bl");
    expect(nearestCorner(phone, 380, 800)).toBe("br");
  });

  it("pipRect is landscape-shaped on landscape screens", () => {
    const r = pipRect(desktop, insets, "tr");
    expect(r.w).toBeGreaterThan(r.h);
  });
});
