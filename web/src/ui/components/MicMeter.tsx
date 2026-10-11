import { TID } from "../../core/testids.ts";
import { MicOffIcon } from "../icons.tsx";

const BARS = [0.55, 0.85, 1, 0.85, 0.55];

/** Five soft bars that follow the local mic level (0..1). Decorative; the mic button carries the state. */
export function MicMeter({ level, muted }: { level: number; muted: boolean }) {
  const l = muted ? 0 : Math.min(1, Math.max(0, level));
  return (
    <div class={muted ? "mic-meter is-muted" : "mic-meter"} data-testid={TID.micLevel} aria-hidden="true">
      {muted ? (
        <MicOffIcon size={16} />
      ) : (
        BARS.map((w, i) => (
          <span
            key={i}
            class="mic-meter__bar"
            style={{ transform: `scaleY(${(0.18 + 0.82 * Math.min(1, l * 1.6 * w)).toFixed(3)})` }}
          />
        ))
      )}
    </div>
  );
}
