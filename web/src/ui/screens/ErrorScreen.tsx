import { TID } from "../../core/testids.ts";
import type { CallController } from "../../core/types.ts";
import { OpenElsewhere } from "../components/Coach.tsx";
import { useBrowser } from "../context.ts";
import { errorCopy, type ScreenErrorCode, unsupportedCopy } from "../copy.ts";
import { AlertIcon } from "../icons.tsx";
import { reloadApp } from "../pwa/update.ts";

/**
 * The call link to offer on the unsupported screen. The controller never parsed it there (`state.link` is null), so
 * fall back to the address bar when it is a `/c#secret` link; Home → Start in an unsupported browser has none.
 */
export function unsupportedLink(stateLink: string | null, loc: Pick<Location, "href" | "pathname" | "hash">) {
  if (stateLink) return stateLink;
  return /^\/c\/?$/.test(loc.pathname) && loc.hash.length > 1 ? loc.href : null;
}

/** Fatal problems before joining. Each code gets plain words and at most two ways forward. */
export function ErrorScreen({
  code,
  controller,
}: {
  code: ScreenErrorCode;
  controller: CallController | null;
}) {
  const b = useBrowser();
  const link = controller?.state.value.link ?? null;
  const name = controller?.state.value.local.name;
  const callLink = code === "unsupported" ? unsupportedLink(link, location) : null;
  const copy = code === "unsupported" ? unsupportedCopy(b, callLink !== null) : errorCopy(code);
  const actions = copy.actions.filter((a) => a === "reload" || controller);

  return (
    <main class="screen center-screen" data-testid={TID.errorScreen}>
      <section class="center-screen__body">
        <div class="badge-icon" aria-hidden="true">
          <AlertIcon size={28} />
        </div>
        <h1 class="center-screen__title">{copy.title}</h1>
        <p class="center-screen__text center-screen__text--large">{copy.body}</p>
        <p class="error-code" data-testid={TID.errorCode}>
          Code: {code}
        </p>
      </section>
      {callLink && (
        <section class="center-screen__actions">
          <OpenElsewhere link={callLink} b={b} />
        </section>
      )}
      {actions.length > 0 && (
        <section class="center-screen__actions">
          {actions.map((a, i) => {
            const cls = i === 0 ? "btn btn--primary btn--block" : "btn btn--quiet btn--block";
            if (a === "reload")
              return (
                <button key={a} type="button" class={cls} data-testid={TID.errorAction} onClick={reloadApp}>
                  Reload
                </button>
              );
            if (a === "retry")
              return (
                <button
                  key={a}
                  type="button"
                  class={cls}
                  data-testid={TID.errorAction}
                  onClick={() => void controller?.prepare({ link: link ?? location.href, name })}
                >
                  Try again
                </button>
              );
            return (
              <button
                key={a}
                type="button"
                class={cls}
                data-testid={TID.newCallButton}
                onClick={() => void controller?.prepare({ name })}
              >
                Start a new call
              </button>
            );
          })}
        </section>
      )}
    </main>
  );
}
