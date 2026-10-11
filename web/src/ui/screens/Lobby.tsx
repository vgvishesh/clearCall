import { MAX_NAME_LENGTH } from "@clearcall/protocol";
import { useEffect, useRef, useState } from "preact/hooks";
import { TID } from "../../core/testids.ts";
import { CamButton, FlipButton, MicButton } from "../components/Controls.tsx";
import { MicMeter } from "../components/MicMeter.tsx";
import { SwitchRow } from "../components/Switch.tsx";
import { Avatar, Video } from "../components/Video.tsx";
import { useCall } from "../context.ts";
import { deviceHelp } from "../copy.ts";
import { AlertIcon, HeadphonesIcon, MusicIcon, ShareIcon } from "../icons.tsx";
import { detectPlatform } from "../platform.ts";
import { shareWithFeedback } from "../toast.ts";

/** `/c#…` before joining: preview, name, devices, Join. Device problems are shown inline, never as a dead end. */
export function Lobby() {
  const c = useCall();
  const s = c.state.value;
  const local = s.local;
  const [name, setName] = useState(local.name);
  const touched = useRef(false);
  const joining = s.phase === "joining";

  // Adopt the remembered name once the controller has loaded it, unless the user already typed.
  useEffect(() => {
    if (!touched.current) setName(local.name);
  }, [local.name]);

  const deviceError =
    s.error && (s.error.code === "permission-denied" || s.error.code === "no-devices") ? s.error.code : null;
  const noCam = !local.camAvailable;
  const noMic = !local.micAvailable;
  const help =
    deviceError && (noCam || noMic) ? deviceHelp(deviceError, !noCam, !noMic, detectPlatform()) : null;
  const starting = s.phase === "idle" || (!local.stream && !help);
  const showVideo = local.camOn && !!local.stream && local.stream.getVideoTracks().length > 0;

  const joinLabel = joining
    ? "Joining…"
    : noCam && noMic
      ? "Join without camera and mic"
      : noCam
        ? "Join without camera"
        : "Join call";

  const join = (e?: Event) => {
    e?.preventDefault();
    if (joining || s.phase !== "lobby") return;
    void c.join(name.trim());
  };

  return (
    <main class={help ? "screen lobby has-notice" : "screen lobby"} data-testid={TID.lobby}>
      <div class="lobby__preview force-dark" data-testid={TID.lobbyPreview}>
        {showVideo ? (
          <Video stream={local.stream!} mirrored={local.facing === "user"} />
        ) : (
          <div class="lobby__placeholder">
            <Avatar name={name} />
            <p class="lobby__placeholder-text">
              {starting
                ? "Starting camera…"
                : noCam
                  ? deviceError === "permission-denied"
                    ? noMic
                      ? "Camera and mic are blocked"
                      : "Camera is blocked"
                    : "No camera"
                  : "Camera is off"}
            </p>
          </div>
        )}
        <div class="lobby__meter">
          <MicMeter level={local.audioLevel} muted={!local.micOn || noMic} />
        </div>
        <div class="lobby__devices">
          <MicButton c={c} local={local} />
          <CamButton c={c} local={local} />
          {local.canSwitchCamera && !noCam && <FlipButton c={c} local={local} />}
        </div>
      </div>

      <form class="lobby__panel" onSubmit={join}>
        <h1 class="lobby__title">Ready to join?</h1>

        {help && (
          <div class="notice" role="alert">
            <AlertIcon class="notice__icon" />
            <div class="notice__body">
              <p class="notice__title">{help.title}</p>
              <p class="notice__text">{help.steps ?? help.body}</p>
              <button
                type="button"
                class="btn btn--small btn--quiet notice__action"
                data-testid={TID.retryMedia}
                onClick={() => void c.prepare({ link: s.link ?? location.href, name: name.trim() })}
              >
                Try again
              </button>
            </div>
          </div>
        )}

        <label class="visually-hidden" for="name-input">
          Your name
        </label>
        <input
          id="name-input"
          class="input"
          data-testid={TID.nameInput}
          type="text"
          placeholder="Your name"
          maxLength={MAX_NAME_LENGTH}
          autocomplete="nickname"
          autocapitalize="words"
          enterKeyHint="go"
          value={name}
          onInput={(e) => {
            touched.current = true;
            const v = e.currentTarget.value.slice(0, MAX_NAME_LENGTH);
            setName(v);
            c.setName(v);
          }}
        />

        {!noMic && (
          <SwitchRow
            testid={TID.musicModeToggle}
            checked={local.mode === "music"}
            onChange={(on) => void c.setMode(on ? "music" : "voice")}
            icon={<MusicIcon size={20} />}
            label="Music mode"
            description="Full, natural sound for instruments and singing"
          />
        )}
        {local.mode === "music" && !noMic && (
          <p class="hint">
            <HeadphonesIcon size={18} />
            Use headphones for the best music sound.
          </p>
        )}

        <div class="lobby__actions">
          <button
            type="submit"
            class="btn btn--primary btn--block"
            data-testid={TID.joinButton}
            disabled={joining || s.phase !== "lobby"}
          >
            {joinLabel}
          </button>
          <button
            type="button"
            class="btn btn--quiet btn--block lobby__share"
            data-testid={TID.shareLink}
            aria-label="Share link"
            onClick={() => void shareWithFeedback(() => c.shareLink())}
            disabled={!s.link}
          >
            <ShareIcon size={20} />
            <span class="lobby__share-label">Share link</span>
          </button>
        </div>
      </form>
    </main>
  );
}
