import { TID } from "../../core/testids.ts";
import { InstallHint } from "../components/InstallHint.tsx";
import { useCall } from "../context.ts";
import { endedReason } from "../copy.ts";
import { describeDuration, formatDuration } from "../format.ts";
import { PhoneEndedIcon } from "../icons.tsx";
import { reloadApp } from "../pwa/update.ts";

export function Ended() {
  const c = useCall();
  const s = c.state.value;
  const duration = s.joinedAt !== null && s.endedAt !== null ? Math.max(0, s.endedAt - s.joinedAt) : null;
  const reason = endedReason(s.error?.code);
  const needsReload = s.error?.code === "version-mismatch";

  return (
    <main class="screen center-screen ended" data-testid={TID.endedScreen}>
      <section class="center-screen__body">
        <div class="badge-icon" aria-hidden="true">
          <PhoneEndedIcon size={28} />
        </div>
        <h1 class="center-screen__title">Call ended</h1>
        {duration !== null && (
          <p class="ended__duration">
            <span aria-hidden="true">{formatDuration(duration)}</span>
            <span class="visually-hidden">Duration {describeDuration(duration)}</span>
          </p>
        )}
        {reason && <p class="center-screen__text">{reason}</p>}
      </section>
      <section class="center-screen__actions">
        <InstallHint />
        {needsReload ? (
          <button
            type="button"
            class="btn btn--primary btn--block"
            data-testid={TID.rejoinButton}
            onClick={reloadApp}
          >
            Reload
          </button>
        ) : (
          <button
            type="button"
            class="btn btn--primary btn--block"
            data-testid={TID.rejoinButton}
            disabled={!s.link}
            onClick={() => void c.prepare({ link: s.link ?? undefined, name: s.local.name })}
          >
            Rejoin
          </button>
        )}
        <button
          type="button"
          class="btn btn--quiet btn--block"
          data-testid={TID.newCallButton}
          onClick={() => void c.prepare({ name: s.local.name })}
        >
          New call
        </button>
      </section>
    </main>
  );
}
