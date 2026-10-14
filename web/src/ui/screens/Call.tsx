import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { TID } from "../../core/testids.ts";
import type { CallState } from "../../core/types.ts";
import { ControlsBar } from "../components/Controls.tsx";
import { Sheet } from "../components/Sheet.tsx";
import { SwitchRow } from "../components/Switch.tsx";
import { Tile, type TileModel, type TileVariant } from "../components/Tile.tsx";
import { HintsContext, useCall } from "../context.ts";
import { formatDuration } from "../format.ts";
import { useHeight, useNow, useViewport } from "../hooks.ts";
import { HeadphonesIcon, MusicIcon, PeopleIcon, ShareIcon, SpeakerIcon } from "../icons.tsx";
import { type Corner, computeLayout, nearestCorner, type Rect } from "../layout.ts";
import { shareWithFeedback } from "../toast.ts";
import { createViewReporter } from "../viewReporter.ts";

const SELF_ID = "self";
const AUTO_HIDE_MS = 4000;

export function Call() {
  const c = useCall();
  const hints = useContext(HintsContext);
  const s = c.state.value;
  const screen = useViewport();
  const [headerEl, setHeaderEl] = useState<HTMLElement | null>(null);
  const [footerEl, setFooterEl] = useState<HTMLElement | null>(null);
  const headerH = useHeight(headerEl);
  const footerH = useHeight(footerEl);
  const [moreOpen, setMoreOpen] = useState(!!hints.moreOpen);
  const [pipCorner, setPipCorner] = useState<Corner>("tr");
  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const spotlight = useRef<string | null>(null);
  const reporter = useMemo(() => createViewReporter((id, h) => c.reportView(id, h)), [c]);
  useEffect(() => () => reporter.dispose(), [reporter]);

  const remotes = s.participants;
  const n = remotes.length + 1;

  // Spotlight (wide screens, 5+): follow the active speaker, stay put when nobody speaks.
  if (s.activeSpeakerId && remotes.some((p) => p.id === s.activeSpeakerId))
    spotlight.current = s.activeSpeakerId;
  else if (!remotes.some((p) => p.id === spotlight.current)) spotlight.current = remotes[0]?.id ?? null;

  const [probeEl, setProbeEl] = useState<HTMLElement | null>(null);
  const side = useSafeSides(probeEl, screen.w);
  const layout = computeLayout({
    remoteIds: remotes.map((p) => p.id),
    selfId: SELF_ID,
    screen,
    insets: { top: headerH, bottom: footerH, left: side.left, right: side.right },
    spotlightId: spotlight.current,
    pipCorner,
  });

  // Controls auto-hide only when watching one other person's video.
  const pairRemote = layout.kind === "pair" ? remotes[0] : undefined;
  const autoHide = !!pairRemote?.camOn && s.phase === "in-call" && !moreOpen && !s.audioBlocked;
  const [chromeHidden, setChromeHidden] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const poke = useCallback(() => {
    setChromeHidden(false);
    clearTimeout(hideTimer.current);
    if (autoHide) hideTimer.current = setTimeout(() => setChromeHidden(true), AUTO_HIDE_MS);
  }, [autoHide]);
  useEffect(() => {
    poke();
    return () => clearTimeout(hideTimer.current);
  }, [poke]);

  const onStageTap = () => {
    if (!autoHide) return;
    if (chromeHidden) poke();
    else {
      clearTimeout(hideTimer.current);
      setChromeHidden(true);
    }
  };

  const tiles: { model: TileModel; variant: TileVariant; rect: Rect }[] = [];
  for (const p of remotes) {
    const rect = layout.rects[p.id];
    if (!rect) continue;
    tiles.push({
      // Video paused by the CPU guard (ADR-0010): peers stopped sending us video — show their avatar, not a frozen frame.
      model: { ...p, camOn: p.camOn && s.videoLimited !== "paused", isSelf: false },
      rect,
      variant:
        layout.fullBleedId === p.id
          ? "full"
          : layout.kind === "spotlight" && spotlight.current === p.id
            ? "main"
            : "grid",
    });
  }
  const selfRect = layout.rects[SELF_ID];
  if (selfRect) {
    tiles.push({
      model: {
        id: SELF_ID,
        name: s.local.name,
        isSelf: true,
        stream: s.local.stream,
        camOn: s.local.camOn,
        micOn: s.local.micOn,
        speaking: false,
        status: "connected",
        quality: "unknown",
      },
      rect: selfRect,
      variant:
        layout.pipId === SELF_ID || layout.dockId === SELF_ID
          ? "pip"
          : layout.fullBleedId === SELF_ID
            ? "full"
            : "grid",
    });
  }

  const pipHandlers = {
    onPointerDown: (e: PointerEvent) => {
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      dragStart.current = { x: e.clientX, y: e.clientY };
    },
    onPointerMove: (e: PointerEvent) => {
      const start = dragStart.current;
      if (!start) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (drag || Math.hypot(dx, dy) > 6) setDrag({ dx, dy });
    },
    onPointerUp: () => {
      dragStart.current = null;
      if (!drag || !selfRect) return;
      const cx = selfRect.x + drag.dx + selfRect.w / 2;
      const cy = selfRect.y + drag.dy + selfRect.h / 2;
      setPipCorner(nearestCorner(screen, cx, cy));
      setDrag(null);
    },
    onPointerCancel: () => {
      dragStart.current = null;
      setDrag(null);
    },
    onClick: (e: MouseEvent) => e.stopPropagation(),
  };

  const rootClass = [
    "screen",
    "call",
    `call--${layout.kind}`,
    chromeHidden ? "is-chrome-hidden" : "",
    layout.dockId ? "has-dock" : "",
    s.phase === "reconnecting" ? "is-reconnecting" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <main
      class={rootClass}
      data-testid={TID.callScreen}
      data-layout={layout.kind}
      style={{
        "--header-h-measured": `${headerH}px`,
        "--footer-h": `${footerH}px`,
        "--dock-w": layout.dockId ? `${Math.round(layout.rects[layout.dockId]?.w ?? 0)}px` : "0px",
      }}
      onPointerMove={(e) => {
        if (e.pointerType === "mouse" && !chromeHidden) poke();
        else if (e.pointerType === "mouse" && chromeHidden) poke();
      }}
      onKeyDown={poke}
    >
      <div class="safe-probe" ref={setProbeEl} aria-hidden="true" />
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: tapping video to reveal controls is a pointer convenience; keyboard focus already reveals them */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: see above */}
      <div class="call__stage" onClick={onStageTap}>
        {tiles.map((t) => (
          <Tile
            key={t.model.id}
            model={t.model}
            rect={t.rect}
            variant={t.variant}
            reporter={reporter}
            onRetry={(id) => c.retryPeer(id)}
            docked={layout.dockId === t.model.id}
            dragOffset={layout.pipId === t.model.id ? drag : null}
            pointerHandlers={layout.pipId === t.model.id ? pipHandlers : undefined}
          />
        ))}
      </div>

      <header class="call__header" ref={setHeaderEl}>
        <div class="call__status pill">
          <PeopleIcon size={18} />
          <span data-testid={TID.participantCount}>{n}</span>
          <span class="visually-hidden">{n === 1 ? " person in call" : " people in call"}</span>
          <span class="pill__sep" aria-hidden="true" />
          <CallClock state={s} />
        </div>
        {s.phase === "reconnecting" && (
          <div class="banner" data-testid={TID.reconnectingBanner} role="status">
            <span class="spinner" aria-hidden="true" />
            Reconnecting…
          </div>
        )}
        {s.phase !== "reconnecting" && s.videoLimited === "paused" && (
          <div class="banner banner--calm" data-testid={TID.videoPausedNotice} role="status">
            Video paused for clear audio
          </div>
        )}
      </header>

      {layout.kind === "solo" && (
        <section class="waiting" aria-live="polite">
          {s.phase === "joining" ? (
            <p class="waiting__title">Connecting…</p>
          ) : (
            <>
              <p class="waiting__title">Waiting for others</p>
              <p class="waiting__text">Anyone with the link can join.</p>
              <button
                type="button"
                class="btn btn--primary btn--block btn--compact"
                data-testid={TID.shareLink}
                onClick={() => void shareWithFeedback(() => c.shareLink())}
              >
                <ShareIcon size={20} />
                Share link
              </button>
            </>
          )}
        </section>
      )}

      {s.audioBlocked && (
        <button
          type="button"
          class="btn btn--primary enable-audio"
          data-testid={TID.enableAudio}
          onClick={() => void c.resumeAudio()}
        >
          <SpeakerIcon size={20} />
          Tap to enable audio
        </button>
      )}

      <footer class="call__footer" ref={setFooterEl}>
        <ControlsBar
          c={c}
          local={s.local}
          showShare={layout.kind !== "solo"}
          moreOpen={moreOpen}
          onMore={() => setMoreOpen(true)}
        />
      </footer>

      {moreOpen && (
        <Sheet title="More" onClose={() => setMoreOpen(false)}>
          <SwitchRow
            testid={TID.musicModeToggle}
            checked={s.local.mode === "music"}
            onChange={(on) => void c.setMode(on ? "music" : "voice")}
            icon={<MusicIcon size={20} />}
            label="Music mode"
            description="Full, natural sound for instruments and singing. Turns off noise suppression."
          />
          {s.local.mode === "music" && (
            <p class="hint">
              <HeadphonesIcon size={18} />
              Use headphones for the best music sound.
            </p>
          )}
        </Sheet>
      )}
    </main>
  );
}

function CallClock({ state }: { state: CallState }) {
  const now = useNow(1000);
  if (state.phase === "joining" || state.joinedAt === null)
    return <span class="call__clock">Connecting</span>;
  const ms = now - state.joinedAt;
  return (
    <span class="call__clock">
      <span class="visually-hidden">Call time </span>
      {formatDuration(ms)}
    </span>
  );
}

/** Left/right safe-area insets (landscape notch), resolved from a hidden probe padded with env() values. */
function useSafeSides(probe: HTMLElement | null, _w: number) {
  if (!probe) return { left: 0, right: 0 };
  const cs = getComputedStyle(probe);
  return { left: Number.parseFloat(cs.paddingLeft) || 0, right: Number.parseFloat(cs.paddingRight) || 0 };
}
