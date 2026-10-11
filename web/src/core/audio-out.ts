/**
 * Remote audio playback through controller-owned hidden <audio> elements (one per participant, independent of
 * layout; the UI's <video> elements are always muted). Autoplay rejection (iOS) → `blocked`, cleared by
 * `resume()` from a user gesture.
 */
import { errInfo, type Logger, nullLogger, short } from "./log.ts";

export interface AudioElementLike {
  srcObject: MediaStream | null;
  autoplay: boolean;
  muted: boolean;
  play(): Promise<void>;
  pause(): void;
  setAttribute?(k: string, v: string): void;
  remove?(): void;
}

export interface RemoteAudioOptions {
  createElement: () => AudioElementLike | null;
  log?: Logger;
  onBlocked: (blocked: boolean) => void;
}

export class RemoteAudio {
  private els = new Map<string, { el: AudioElementLike; stream: MediaStream }>();
  private blocked = false;
  private readonly log: Logger;

  constructor(private readonly o: RemoteAudioOptions) {
    this.log = o.log ?? nullLogger;
  }

  get isBlocked(): boolean {
    return this.blocked;
  }

  /** Make the set of elements match the participants with a stream. */
  sync(participants: { id: string; stream: MediaStream | null }[]): void {
    const want = new Map(participants.filter((p) => p.stream).map((p) => [p.id, p.stream!]));
    for (const [id, x] of this.els) {
      if (!want.has(id)) {
        this.release(x.el);
        this.els.delete(id);
      }
    }
    for (const [id, stream] of want) {
      const cur = this.els.get(id);
      if (cur?.stream === stream) continue;
      let el = cur?.el ?? null;
      if (!el) {
        el = this.o.createElement();
        if (!el) return;
        el.autoplay = true;
        el.muted = false;
        el.setAttribute?.("playsinline", "");
        el.setAttribute?.("data-clearcall-audio", short(id));
      }
      el.srcObject = stream;
      this.els.set(id, { el, stream });
      this.play(id, el);
    }
  }

  private play(id: string, el: AudioElementLike) {
    let p: Promise<void> | undefined;
    try {
      p = el.play();
    } catch (e) {
      this.onPlayError(id, e);
      return;
    }
    void p?.then(
      () => {},
      (e) => this.onPlayError(id, e),
    );
  }

  private onPlayError(id: string, e: unknown) {
    const info = errInfo(e);
    if (info.err === "NotAllowedError") {
      this.log.warn("autoplay blocked", { peer: short(id) });
      this.setBlocked(true);
    } else if (info.err !== "AbortError") this.log.warn("audio play failed", { peer: short(id), ...info });
  }

  private setBlocked(b: boolean) {
    if (this.blocked === b) return;
    this.blocked = b;
    this.o.onBlocked(b);
  }

  /** From a user gesture: retry playback everywhere. Resolves to the new blocked state. */
  async resume(): Promise<boolean> {
    let anyBlocked = false;
    await Promise.all(
      [...this.els.entries()].map(async ([id, { el }]) => {
        try {
          await el.play();
        } catch (e) {
          if (errInfo(e).err === "NotAllowedError") anyBlocked = true;
          else this.log.warn("audio resume failed", { peer: short(id), ...errInfo(e) });
        }
      }),
    );
    if (this.blocked !== anyBlocked) {
      this.blocked = anyBlocked;
      this.o.onBlocked(anyBlocked);
    }
    this.log.info("audio resume", { blocked: anyBlocked });
    return anyBlocked;
  }

  private release(el: AudioElementLike) {
    try {
      el.pause();
    } catch {}
    el.srcObject = null;
    el.remove?.();
  }

  close(): void {
    for (const { el } of this.els.values()) this.release(el);
    this.els.clear();
    if (this.blocked) {
      this.blocked = false;
      this.o.onBlocked(false);
    }
  }

  get size(): number {
    return this.els.size;
  }
}
