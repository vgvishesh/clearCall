import type { HTMLAttributes } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { TID } from "../../core/testids.ts";
import type { ConnectionQuality, PeerConnectionStatus } from "../../core/types.ts";
import { displayName } from "../format.ts";
import { MicOffIcon, RetryIcon, SignalWeakIcon } from "../icons.tsx";
import type { Rect } from "../layout.ts";
import type { ViewReporter } from "../viewReporter.ts";
import { Avatar, Video } from "./Video.tsx";

export type TileVariant = "full" | "pip" | "grid" | "main";

export interface TileModel {
  id: string;
  name: string;
  isSelf: boolean;
  stream: MediaStream | null;
  camOn: boolean;
  micOn: boolean;
  speaking: boolean;
  status: PeerConnectionStatus;
  quality: ConnectionQuality;
}

export function Tile(props: {
  model: TileModel;
  rect: Rect;
  variant: TileVariant;
  reporter?: ViewReporter;
  onRetry?: (id: string) => void;
  /** Self thumbnail docked in the header row: PiP look, but fixed in place (not draggable). */
  docked?: boolean;
  dragOffset?: { dx: number; dy: number } | null;
  pointerHandlers?: HTMLAttributes<HTMLDivElement>;
}) {
  const { model: p, rect, variant, reporter } = props;
  const ref = useRef<HTMLDivElement>(null);
  const showVideo = p.camOn && p.stream !== null && p.stream.getVideoTracks().length > 0;
  const name = p.isSelf ? "You" : displayName(p.name);

  // Report the rendered height of remote tiles so the engine can pick a matching resolution.
  useEffect(() => {
    const el = ref.current;
    if (!el || p.isSelf || !reporter || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) reporter.observe(p.id, e.contentRect.height);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      reporter.hide(p.id);
    };
  }, [p.id, p.isSelf, reporter]);

  const dx = props.dragOffset?.dx ?? 0;
  const dy = props.dragOffset?.dy ?? 0;
  const style = {
    transform: `translate3d(${Math.round(rect.x + dx)}px, ${Math.round(rect.y + dy)}px, 0)`,
    width: `${Math.round(rect.w)}px`,
    height: `${Math.round(rect.h)}px`,
  };
  const failed = p.status === "failed";
  const connecting = !p.isSelf && (p.status === "connecting" || p.status === "reconnecting");
  const ring = p.speaking && !failed && variant !== "full";
  const classes = [
    "tile",
    `tile--${variant}`,
    ring ? "is-speaking" : "",
    props.dragOffset ? "is-dragging" : "",
    props.docked ? "is-docked" : "",
    showVideo ? "has-video" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const stateWords = [!p.micOn ? "muted" : "", !p.camOn ? "camera off" : "", failed ? "can’t connect" : ""]
    .filter(Boolean)
    .join(", ");

  return (
    <div
      ref={ref}
      class={classes}
      style={style}
      data-testid={p.isSelf ? TID.selfTile : TID.participantTile}
      data-participant-id={p.id}
      data-name={p.name}
      data-status={p.status}
      data-mic={String(p.micOn)}
      data-cam={String(p.camOn)}
      {...props.pointerHandlers}
    >
      {showVideo ? (
        <Video
          stream={p.stream!}
          mirrored={p.isSelf}
          boxAspect={rect.h > 0 ? rect.w / rect.h : undefined}
          letterbox={!p.isSelf && (variant === "full" || variant === "main")}
        />
      ) : (
        <Avatar name={p.isSelf ? p.name : name} />
      )}
      {variant !== "pip" && (
        <div class="tile__label">
          {!p.micOn && <MicOffIcon size={16} class="tile__muted" />}
          <span class="tile__name">{name}</span>
          {stateWords && <span class="visually-hidden">, {stateWords}</span>}
        </div>
      )}
      {variant === "pip" && <span class="visually-hidden">You</span>}
      {variant === "pip" && !p.micOn && (
        <span class="tile__pip-muted">
          <MicOffIcon size={16} />
        </span>
      )}
      {p.quality === "poor" && !failed && (
        <span class="tile__quality" title="Poor connection">
          <SignalWeakIcon size={18} />
          <span class="visually-hidden">Poor connection</span>
        </span>
      )}
      {connecting && (
        <div class="tile__status">
          <span class="spinner" aria-hidden="true" />
          <span>{p.status === "reconnecting" ? "Reconnecting…" : "Connecting…"}</span>
        </div>
      )}
      {failed && (
        <div class="tile__failed">
          <span class="tile__failed-text">Can’t connect</span>
          <button
            type="button"
            class="btn btn--small btn--inverse"
            data-testid={TID.retryPeer}
            aria-label={`Retry connecting to ${name}`}
            onClick={() => props.onRetry?.(p.id)}
          >
            <RetryIcon size={18} />
            Retry
          </button>
        </div>
      )}
    </div>
  );
}
