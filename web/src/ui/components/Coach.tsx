/** Building blocks of the permission coach (lobby) and the unsupported-browser error screen. */
import type { ComponentChildren } from "preact";
import { TID } from "../../core/testids.ts";
import { boldParts, type CoachStep } from "../copy.ts";
import { CopyIcon, ExternalIcon } from "../icons.tsx";
import { type BrowserInfo, openInBrowserUrl, recommendedBrowser } from "../platform.ts";
import { copyWithFeedback } from "../toast.ts";
import { StepGlyph } from "./CoachArt.tsx";

/** Text with **bold** words (the labels to look for on screen). */
export function Rich({ text }: { text: string }) {
  return (
    <>
      {boldParts(text).map((p, i) =>
        p.bold ? <strong key={i}>{p.text}</strong> : <span key={i}>{p.text}</span>,
      )}
    </>
  );
}

/** A calm card: picture, one sentence, then at most one primary action and one secondary link. */
export function CoachCard(props: {
  testid: string;
  art?: ComponentChildren;
  title: string;
  text?: string;
  big?: boolean;
  children?: ComponentChildren;
  live?: boolean;
}) {
  return (
    <section
      class={props.big ? "coach coach--big" : "coach"}
      data-testid={props.testid}
      aria-live={props.live ? "polite" : undefined}
    >
      {props.art && <div class="coach__art">{props.art}</div>}
      <h2 class="coach__title">
        <Rich text={props.title} />
      </h2>
      {props.text && (
        <p class="coach__text">
          <Rich text={props.text} />
        </p>
      )}
      {props.children}
    </section>
  );
}

export function CoachSteps({ steps }: { steps: CoachStep[] }) {
  return (
    <ol class="coach__steps">
      {steps.map((s, i) => (
        <li key={i} class="coach__step">
          <span class="coach__step-num" aria-hidden="true">
            {i + 1}
          </span>
          <span class="coach__step-text">
            <Rich text={s.text} />
          </span>
          <span class="coach__step-glyph" aria-hidden="true">
            <StepGlyph glyph={s.glyph} />
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * "Open in Chrome / Safari" + "Copy link". When this browser can't open another one (iOS < 17, desktop), Copy link
 * becomes the primary action.
 */
/** "Open in Chrome/Safari" + "Copy link"; `children` = extra secondary actions in the same group (even spacing). */
export function OpenElsewhere({
  link,
  b,
  children,
}: {
  link: string;
  b: BrowserInfo;
  children?: ComponentChildren;
}) {
  const browser = recommendedBrowser(b.platform);
  const url = b.platform === "desktop" ? null : openInBrowserUrl(link, b);
  const copy = () => void copyWithFeedback(link, `Link copied. Paste it in ${browser}.`);
  return (
    <div class="coach__actions">
      {url && (
        <a class="btn btn--primary btn--block btn--coach" data-testid={TID.openInBrowser} href={url}>
          <ExternalIcon size={22} />
          Open in {browser}
        </a>
      )}
      <button
        type="button"
        class={url ? "btn btn--link" : "btn btn--primary btn--block btn--coach"}
        data-testid={TID.copyLink}
        onClick={copy}
      >
        <CopyIcon size={url ? 20 : 22} />
        Copy link
      </button>
      {children}
    </div>
  );
}
