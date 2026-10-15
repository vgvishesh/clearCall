/**
 * Camera/mic permission state via the Permissions API (permission coach).
 *
 * The engine never shows a browser prompt without a tap; this module only READS what the browser already decided:
 * - `prepare()` acquires straight away only when both are "granted", and skips getUserMedia when either is "denied".
 * - After a blocked prompt, the controller re-acquires by itself only when a query reports "granted" (a `change`
 *   event, or a query on becoming visible again after the user went to Settings).
 *
 * Browsers differ: Firefox (older) and Safari < 16 throw for `{name: "camera"}`; some never fire `change`; Safari may
 * hand out a fresh PermissionStatus per query. Anything unexpected → "unknown" (= behave as if we must ask).
 */
import type { Clock, TimerHandle } from "./clock.ts";
import { errInfo, type Logger, nullLogger } from "./log.ts";

export type PermState = "granted" | "denied" | "prompt" | "unknown";
export type MediaKind = "audio" | "video";
export type PermSnapshot = Record<MediaKind, PermState>;

export interface PermissionStatusLike {
  readonly state: string;
  addEventListener?(type: "change", fn: () => void): void;
  removeEventListener?(type: "change", fn: () => void): void;
}

export interface PermissionsLike {
  query(descriptor: { name: string }): Promise<PermissionStatusLike>;
}

const NAMES: Record<MediaKind, string> = { audio: "microphone", video: "camera" };
export const UNKNOWN: PermSnapshot = { audio: "unknown", video: "unknown" };

function norm(s: unknown): PermState {
  return s === "granted" || s === "denied" || s === "prompt" ? s : "unknown";
}

export interface DevicePermissionsOptions {
  permissions: PermissionsLike | undefined;
  clock: Clock;
  log?: Logger;
  /** A query that hangs (seen in some webviews) counts as "unknown" after this long. */
  timeoutMs?: number;
  /** A status reported a change (state already normalized). */
  onChange?: (kind: MediaKind, state: PermState) => void;
}

/** Queries camera + microphone permission and relays `change` events. One instance per lobby/call. */
export class DevicePermissions {
  private readonly log: Logger;
  private statuses = new Map<MediaKind, { status: PermissionStatusLike; fn: () => void }>();
  private closed = false;
  /** Last known states (from a query or a change event). */
  last: PermSnapshot = { ...UNKNOWN };

  constructor(private readonly o: DevicePermissionsOptions) {
    this.log = o.log ?? nullLogger;
  }

  /** True when the browser has a Permissions API at all (no API → never auto re-acquire). */
  get supported(): boolean {
    return typeof this.o.permissions?.query === "function";
  }

  /** Query both; never rejects. */
  async query(): Promise<PermSnapshot> {
    if (!this.supported || this.closed) return { ...UNKNOWN };
    const [audio, video] = await Promise.all([this.queryOne("audio"), this.queryOne("video")]);
    if (!this.closed) this.last = { audio, video };
    return { audio, video };
  }

  private async queryOne(kind: MediaKind): Promise<PermState> {
    let timer: TimerHandle | undefined;
    try {
      const status = await Promise.race([
        this.o.permissions!.query({ name: NAMES[kind] }),
        new Promise<null>((r) => {
          timer = this.o.clock.setTimeout(() => r(null), this.o.timeoutMs ?? 1000);
        }),
      ]);
      if (!status) {
        this.log.debug("permission query timed out", { kind });
        return "unknown";
      }
      this.watch(kind, status);
      return norm(status.state);
    } catch (e) {
      // Firefox / older Safari: "camera" is not a valid PermissionName (TypeError).
      this.log.debug("permission query unsupported", { kind, ...errInfo(e) });
      return "unknown";
    } finally {
      this.o.clock.clearTimeout(timer);
    }
  }

  private watch(kind: MediaKind, status: PermissionStatusLike) {
    if (this.closed || this.statuses.get(kind)?.status === status) return;
    this.unwatch(kind);
    if (typeof status.addEventListener !== "function") return;
    const fn = () => {
      if (this.closed) return;
      const state = norm(status.state);
      this.last = { ...this.last, [kind]: state };
      this.o.onChange?.(kind, state);
    };
    try {
      status.addEventListener("change", fn);
      this.statuses.set(kind, { status, fn });
    } catch {}
  }

  private unwatch(kind: MediaKind) {
    const w = this.statuses.get(kind);
    if (!w) return;
    try {
      w.status.removeEventListener?.("change", w.fn);
    } catch {}
    this.statuses.delete(kind);
  }

  close(): void {
    this.closed = true;
    this.unwatch("audio");
    this.unwatch("video");
  }
}

/**
 * Coarse browser class for QA/telemetry logs — never the UA string itself (plan resolution 14). The UI has its own,
 * richer detection (in-app browsers, OEM browsers) for the help screens.
 */
export function browserClass(ua: string): string {
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && /Mobile\//.test(ua));
  const android = /Android/.test(ua);
  const os = ios ? "ios" : android ? "android" : "desktop";
  let b = "other";
  if (/; wv\)|FBAN|FBAV|Instagram|WhatsApp|Snapchat|Line\//.test(ua)) b = "webview";
  else if (/SamsungBrowser/.test(ua)) b = "samsung";
  else if (/MiuiBrowser|XiaoMi/.test(ua)) b = "miui";
  else if (/Edg(e|A|iOS)?\//.test(ua)) b = "edge";
  else if (/Firefox|FxiOS/.test(ua)) b = "firefox";
  else if (/CriOS|Chrome\//.test(ua)) b = "chrome";
  else if (/Safari\//.test(ua) && /Version\//.test(ua)) b = "safari";
  else if (ios) b = "webview";
  return `${os}-${b}`;
}
