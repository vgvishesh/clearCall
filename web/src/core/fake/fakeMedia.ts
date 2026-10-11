/**
 * Synthetic camera feeds for FakeCallController: a canvas with a soft gradient "room" and a person silhouette,
 * gently moving so it reads as live video in screenshots. Returns null where canvas capture is unavailable
 * (happy-dom unit tests) — the UI then shows avatars.
 */

export interface FakeFeed {
  stream: MediaStream;
  stop(): void;
}

export interface FakeFeedOptions {
  /** Hue 0..360 for the room tint. */
  hue: number;
  portrait?: boolean;
  /** 0..1 horizontal position of the person (0.5 = centered). */
  x?: number;
}

const feeds = new Set<FakeFeed>();
let timer: ReturnType<typeof setInterval> | undefined;
const painters = new Set<(t: number) => void>();

export function createFakeFeed(opts: FakeFeedOptions): FakeFeed | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  if (typeof canvas.captureStream !== "function") return null;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  canvas.width = opts.portrait ? 360 : 640;
  canvas.height = opts.portrait ? 640 : 480;
  const paint = (t: number) => drawScene(ctx, canvas.width, canvas.height, opts, t);
  paint(0);
  const stream = canvas.captureStream(10);
  painters.add(paint);
  timer ??= setInterval(() => {
    const t = performance.now() / 1000;
    for (const p of painters) p(t);
  }, 100);
  const feed: FakeFeed = {
    stream,
    stop() {
      painters.delete(paint);
      for (const tr of stream.getTracks()) tr.stop();
      feeds.delete(feed);
      if (painters.size === 0 && timer) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
  feeds.add(feed);
  return feed;
}

export function stopAllFakeFeeds(): void {
  for (const f of [...feeds]) f.stop();
}

function drawScene(ctx: CanvasRenderingContext2D, w: number, h: number, o: FakeFeedOptions, t: number) {
  const hue = o.hue;
  // Room: soft vertical gradient plus a blurred warm "window" light.
  const bg = ctx.createLinearGradient(0, 0, w * 0.4, h);
  bg.addColorStop(0, `hsl(${hue} 22% 30%)`);
  bg.addColorStop(1, `hsl(${(hue + 25) % 360} 26% 14%)`);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  const glow = ctx.createRadialGradient(w * 0.82, h * 0.2, 0, w * 0.82, h * 0.2, Math.max(w, h) * 0.55);
  glow.addColorStop(0, `hsl(${(hue + 40) % 360} 40% 70% / 0.35)`);
  glow.addColorStop(1, "hsl(0 0% 0% / 0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);

  // Person: shoulders + head, softly lit, with a slight idle sway.
  const cx = w * (o.x ?? 0.5) + Math.sin(t * 0.9 + hue) * w * 0.006;
  const unit = Math.min(w, h);
  const headR = unit * 0.15;
  const headY = h * 0.44 + Math.sin(t * 1.3 + hue) * unit * 0.004;
  const skin = `hsl(${(hue + 200) % 360} 12% 68%)`;
  const shirt = `hsl(${(hue + 180) % 360} 18% 24%)`;

  ctx.fillStyle = shirt;
  ctx.beginPath();
  ctx.ellipse(cx, headY + headR * 3.15, headR * 2.35, headR * 1.9, 0, Math.PI, 0);
  ctx.lineTo(cx + headR * 2.35, h);
  ctx.lineTo(cx - headR * 2.35, h);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = skin;
  ctx.fillRect(cx - headR * 0.38, headY + headR * 0.7, headR * 0.76, headR * 0.9);
  const face = ctx.createRadialGradient(
    cx - headR * 0.3,
    headY - headR * 0.35,
    headR * 0.1,
    cx,
    headY,
    headR * 1.1,
  );
  face.addColorStop(0, `hsl(${(hue + 200) % 360} 14% 78%)`);
  face.addColorStop(1, skin);
  ctx.fillStyle = face;
  ctx.beginPath();
  ctx.ellipse(cx, headY, headR * 0.86, headR, 0, 0, Math.PI * 2);
  ctx.fill();

  // Hair.
  ctx.fillStyle = `hsl(${(hue + 30) % 360} 20% 18%)`;
  ctx.beginPath();
  ctx.ellipse(cx, headY - headR * 0.45, headR * 0.92, headR * 0.62, 0, Math.PI, 0);
  ctx.fill();

  // Vignette.
  const v = ctx.createRadialGradient(w / 2, h / 2, unit * 0.3, w / 2, h / 2, Math.max(w, h) * 0.75);
  v.addColorStop(0, "hsl(0 0% 0% / 0)");
  v.addColorStop(1, "hsl(0 0% 0% / 0.35)");
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, w, h);
}
