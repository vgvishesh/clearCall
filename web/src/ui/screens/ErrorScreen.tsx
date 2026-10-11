import { TID } from "../../core/testids.ts";
import type { CallController } from "../../core/types.ts";
import { errorCopy, type ScreenErrorCode } from "../copy.ts";
import { AlertIcon } from "../icons.tsx";
import { reloadApp } from "../pwa/update.ts";

/** Fatal problems before joining. Each code gets plain words and at most two ways forward. */
export function ErrorScreen({
  code,
  controller,
}: {
  code: ScreenErrorCode;
  controller: CallController | null;
}) {
  const copy = errorCopy(code);
  const link = controller?.state.value.link ?? null;
  const name = controller?.state.value.local.name;
  const actions = copy.actions.filter((a) => a === "reload" || controller);

  return (
    <main class="screen center-screen" data-testid={TID.errorScreen}>
      <section class="center-screen__body">
        <div class="badge-icon" aria-hidden="true">
          <AlertIcon size={28} />
        </div>
        <h1 class="center-screen__title">{copy.title}</h1>
        <p class="center-screen__text">{copy.body}</p>
        <p class="error-code" data-testid={TID.errorCode}>
          Code: {code}
        </p>
      </section>
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
