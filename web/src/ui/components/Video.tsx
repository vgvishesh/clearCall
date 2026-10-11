import { useEffect, useRef, useState } from "preact/hooks";
import { displayName, initialOf } from "../format.ts";

/**
 * Video element for any participant. ALWAYS muted: the controller plays remote audio through its own hidden
 * <audio> elements (types.ts), so layout changes never interrupt sound.
 */
export function Video({
  stream,
  mirrored = false,
  boxAspect,
  letterbox = false,
}: {
  stream: MediaStream;
  mirrored?: boolean;
  /** Width/height of the box the video fills. A portrait video in a clearly landscape box is letterboxed
   * (contain) instead of cropped, so heads aren't cut off; everything else fills (cover). */
  boxAspect?: number;
  /** Big remote views (full-bleed / spotlight): also letterbox when the shapes are far apart, e.g. a laptop's
   * 16:9 camera on a portrait phone, where cover would keep only the middle third of the picture. */
  letterbox?: boolean;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [aspect, setAspect] = useState(0);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    v.muted = true;
    v.defaultMuted = true;
    if (v.srcObject !== stream) v.srcObject = stream;
    v.play().catch(() => {
      // Muted autoplay is allowed everywhere we support; a rejection here only means the element was detached.
    });
  }, [stream]);
  const contain = shouldContain(aspect, boxAspect, letterbox);
  const cls = ["video", mirrored ? "is-mirrored" : "", contain ? "is-contained" : ""]
    .filter(Boolean)
    .join(" ");
  const measure = () => {
    const v = ref.current;
    if (v?.videoWidth && v.videoHeight) setAspect(v.videoWidth / v.videoHeight);
  };
  return (
    <video
      ref={ref}
      class={cls}
      onLoadedMetadata={measure}
      onResize={measure}
      autoplay
      playsinline
      muted
      disablePictureInPicture
    />
  );
}

/** Max crop factor (box shape vs video shape) a big remote view may apply before switching to letterbox. */
export const MAX_CROP = 2.6;

/** True when the video should be letterboxed (object-fit: contain) rather than cropped to fill its box. */
export function shouldContain(
  videoAspect: number,
  boxAspect: number | undefined,
  letterbox = false,
): boolean {
  if (boxAspect === undefined || !(videoAspect > 0) || !(boxAspect > 0)) return false;
  if (videoAspect < 0.9 && boxAspect > 1.5) return true;
  if (!letterbox) return false;
  return Math.max(videoAspect / boxAspect, boxAspect / videoAspect) > MAX_CROP;
}

export function Avatar({ name }: { name: string }) {
  return (
    <div class="avatar" aria-hidden="true">
      <span>{initialOf(displayName(name))}</span>
    </div>
  );
}
