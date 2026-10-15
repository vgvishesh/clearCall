import { MAX_NAME_LENGTH } from "@clearcall/protocol";
import { useContext, useEffect, useRef, useState } from "preact/hooks";
import { TID } from "../../core/testids.ts";
import type { CallController, CallState } from "../../core/types.ts";
import { CoachCard, CoachSteps, OpenElsewhere } from "../components/Coach.tsx";
import { InAppMenuPicture, PromptPicture } from "../components/CoachArt.tsx";
import { CamButton, FlipButton, MicButton } from "../components/Controls.tsx";
import { MicMeter } from "../components/MicMeter.tsx";
import { SwitchRow } from "../components/Switch.tsx";
import { Avatar, Video } from "../components/Video.tsx";
import { HintsContext, useBrowser, useCall } from "../context.ts";
import { askingCopy, deviceHelp, inAppCopy, joinLabel, primeCopy, promptLook, troubleCopy } from "../copy.ts";
import { AlertIcon, ArrowUpIcon, HeadphonesIcon, MusicIcon, ShareIcon } from "../icons.tsx";
import { type BrowserInfo, isInApp, openInBrowserUrl, recommendedBrowser } from "../platform.ts";
import { shareWithFeedback } from "../toast.ts";

const ASK_TROUBLE_MS = 20_000;

/** What the lobby shows above the name/join panel. */
export type LobbyCoach = "in-app" | "prime" | "asking" | "help" | null;

/**
 * Coach state from the controller state: in-app browsers first (open in Chrome/Safari), then the "Get ready" step
 * before any browser prompt, the "Tap Allow" step while asking, and illustrated steps when access was blocked.
 * null = the normal preview (granted, or a missing device that a plain notice explains).
 */
export function lobbyCoach(s: CallState, b: BrowserInfo): LobbyCoach {
  const req = s.local.mediaRequest;
  const denied = s.error?.code === "permission-denied" && (!s.local.camAvailable || !s.local.micAvailable);
  const working = req === "done" && !denied && (s.local.camAvailable || s.local.micAvailable);
  // "asking" from the in-app card's "Try here anyway" shows the normal Tap Allow step (some app browsers can call).
  if (isInApp(b.cls) && !working && req !== "asking") return "in-app";
  if (req === "not-asked") return "prime";
  if (req === "asking") return "asking";
  if (denied) return "help";
  return null;
}

/** `/c#…` before joining: Get ready → preview, name, devices, Join. Device problems never dead-end the user. */
export function Lobby() {
  const c = useCall();
  const s = c.state.value;
  const local = s.local;
  const b = useBrowser();
  const hints = useContext(HintsContext);
  const [name, setName] = useState(local.name);
  const touched = useRef(false);
  const joining = s.phase === "joining";
  const coach = lobbyCoach(s, b);

  // Adopt the remembered name once the controller has loaded it, unless the user already typed.
  useEffect(() => {
    if (!touched.current) setName(local.name);
  }, [local.name]);

  const done = local.mediaRequest === "done";
  const noCam = !local.camAvailable;
  const noMic = !local.micAvailable;
  const missing = s.error?.code === "no-devices" && (noCam || noMic);
  const label = joinLabel({ joining, cam: done && !noCam, mic: done && !noMic });

  const join = (e?: Event) => {
    e?.preventDefault();
    if (joining || s.phase !== "lobby") return;
    void c.join(name.trim());
  };

  const cls = ["screen", "lobby", coach ? "is-coaching" : "", missing && !coach ? "has-notice" : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <main class={cls} data-testid={TID.lobby}>
      {coach ? (
        <Coach
          c={c}
          s={s}
          b={b}
          coach={coach}
          askTroubleMs={hints.askTroubleMs}
          retries={hints.blockedRetries}
        />
      ) : (
        <Preview c={c} s={s} name={name} />
      )}

      <form class="lobby__panel" onSubmit={join}>
        <h1 class="lobby__title">Ready to join?</h1>

        {missing && !coach && (
          <div class="notice" role="alert">
            <AlertIcon class="notice__icon" />
            <div class="notice__body">
              <p class="notice__title">{deviceHelp("no-devices", !noCam, !noMic, b.cls).title}</p>
              <p class="notice__text">{deviceHelp("no-devices", !noCam, !noMic, b.cls).body}</p>
              <button
                type="button"
                class="btn btn--small btn--quiet notice__action"
                data-testid={TID.retryMedia}
                onClick={() => void c.requestMedia()}
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

        {!coach && !noMic && (
          <SwitchRow
            testid={TID.musicModeToggle}
            checked={local.mode === "music"}
            onChange={(on) => void c.setMode(on ? "music" : "voice")}
            icon={<MusicIcon size={20} />}
            label="Music mode"
            description="Full, natural sound for instruments and singing"
          />
        )}
        {!coach && local.mode === "music" && !noMic && (
          <p class="hint">
            <HeadphonesIcon size={18} />
            Use headphones for the best music sound.
          </p>
        )}

        <div class="lobby__actions">
          <button
            type="submit"
            class={
              coach ? "btn btn--quiet btn--block lobby__join" : "btn btn--primary btn--block lobby__join"
            }
            data-testid={TID.joinButton}
            disabled={joining || s.phase !== "lobby"}
          >
            {label}
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

function Preview({ c, s, name }: { c: CallController; s: CallState; name: string }) {
  const local = s.local;
  const noCam = !local.camAvailable;
  // camAvailable false + no error = camera simply not asked for (sound only): "Camera is off", not "No camera".
  const missingCam = noCam && s.error?.code === "no-devices";
  const starting = s.phase === "idle" || (!local.stream && !noCam && local.camOn);
  const showVideo = local.camOn && !!local.stream && local.stream.getVideoTracks().length > 0;
  return (
    <div class="lobby__preview force-dark" data-testid={TID.lobbyPreview}>
      {showVideo ? (
        <Video stream={local.stream!} mirrored={local.facing === "user"} />
      ) : (
        <div class="lobby__placeholder">
          <Avatar name={name} />
          <p class="lobby__placeholder-text">
            {s.phase === "idle"
              ? "Getting ready…"
              : starting
                ? "Starting camera…"
                : missingCam
                  ? "No camera"
                  : "Camera is off"}
          </p>
        </div>
      )}
      <div class="lobby__meter">
        <MicMeter level={local.audioLevel} muted={!local.micOn || !local.micAvailable} />
      </div>
      <div class="lobby__devices">
        <MicButton c={c} local={local} />
        <CamButton c={c} local={local} />
        {local.canSwitchCamera && !noCam && <FlipButton c={c} local={local} />}
      </div>
    </div>
  );
}

function Coach(props: {
  c: CallController;
  s: CallState;
  b: BrowserInfo;
  coach: Exclude<LobbyCoach, null>;
  askTroubleMs?: number;
  retries?: number;
}) {
  const { c, s, b, coach } = props;
  const link = s.link ?? location.href;
  const look = promptLook(b.cls);
  const pictureLabel = "Picture of the question your browser shows, with the Allow button circled";
  const [trouble, setTrouble] = useState(false);
  const [retries, setRetries] = useState(props.retries ?? 0);

  // "asking" for a long time: some app browsers never show the question at all.
  useEffect(() => {
    setTrouble(false);
    if (coach !== "asking") return;
    const t = setTimeout(() => setTrouble(true), props.askTroubleMs ?? ASK_TROUBLE_MS);
    return () => clearTimeout(t);
  }, [coach, props.askTroubleMs]);

  if (coach === "in-app") {
    const copy = inAppCopy(b, openInBrowserUrl(link, b) !== null);
    const art =
      b.platform === "ios" ? (
        <InAppMenuPicture
          browser={recommendedBrowser(b.platform)}
          label={`Picture of the ⋯ menu with Open in ${recommendedBrowser(b.platform)} circled`}
        />
      ) : undefined;
    return (
      <CoachCard testid={TID.inAppNotice} art={art} title={copy.title} text={copy.text}>
        <OpenElsewhere link={link} b={b}>
          {s.local.mediaRequest === "not-asked" && (
            <button
              type="button"
              class="btn btn--link"
              data-testid={TID.allowMedia}
              onClick={() => void c.requestMedia()}
            >
              Try here anyway
            </button>
          )}
        </OpenElsewhere>
      </CoachCard>
    );
  }

  if (coach === "prime") {
    const copy = primeCopy(b.platform);
    return (
      <CoachCard
        testid={TID.permissionPrime}
        art={<PromptPicture look={look} label={pictureLabel} />}
        title={copy.title}
        text={copy.text}
      >
        <div class="coach__actions">
          <button
            type="button"
            class="btn btn--primary btn--block btn--coach"
            data-testid={TID.allowMedia}
            onClick={() => void c.requestMedia()}
          >
            Turn on camera &amp; mic
          </button>
          <button
            type="button"
            class="btn btn--link"
            data-testid={TID.joinSoundOnly}
            onClick={() => void c.requestMedia({ video: false })}
          >
            Join with sound only
          </button>
        </div>
      </CoachCard>
    );
  }

  if (coach === "asking") {
    if (trouble) {
      const copy = troubleCopy(b);
      return (
        <CoachCard testid={TID.permissionPrime} title={copy.title} text={copy.text} live>
          {b.platform === "desktop" ? (
            <div class="coach__actions">
              <button
                type="button"
                class="btn btn--primary btn--block btn--coach"
                data-testid={TID.retryMedia}
                onClick={() => location.reload()}
              >
                Reload page
              </button>
            </div>
          ) : (
            <OpenElsewhere link={link} b={b} />
          )}
        </CoachCard>
      );
    }
    const copy = askingCopy(b);
    const arrow = look.where === "center" ? null : look.where;
    return (
      <CoachCard
        testid={TID.permissionPrime}
        big
        live
        art={
          <>
            {arrow && <ArrowUpIcon size={44} class={`coach__arrow coach__arrow--${arrow}`} />}
            <PromptPicture look={look} label={pictureLabel} />
          </>
        }
        title={copy.title}
        text={copy.text}
      />
    );
  }

  // help: camera and/or mic blocked.
  const help = deviceHelp("permission-denied", s.local.camAvailable, s.local.micAvailable, b.cls);
  const reload = b.platform === "ios" && retries > 0;
  return (
    <CoachCard testid={TID.permissionHelp} title={help.title}>
      <CoachSteps steps={help.steps} />
      <div class="coach__actions">
        {reload && <p class="coach__note">Still blocked? Reload the page, then tap Allow.</p>}
        <button
          type="button"
          class="btn btn--primary btn--block btn--coach"
          data-testid={TID.retryMedia}
          onClick={() => {
            if (reload) return location.reload();
            setRetries((r) => r + 1);
            void c.requestMedia();
          }}
        >
          {reload ? "Reload page" : "I’ve done it — try again"}
        </button>
      </div>
    </CoachCard>
  );
}
