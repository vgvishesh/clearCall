import { useState } from "preact/hooks";
import { TID } from "../../core/testids.ts";
import { CloseIcon, IosShareIcon, LogoMark } from "../icons.tsx";
import { dismissInstallHint, shouldShowInstallHint } from "../platform.ts";

/** iOS Safari only, not in standalone, after a call: how to add Clearcall to the Home Screen. Dismissal is remembered. */
export function InstallHint() {
  const [visible, setVisible] = useState(shouldShowInstallHint);
  if (!visible) return null;
  return (
    <aside class="install-hint" data-testid={TID.installHint} aria-label="Add Clearcall to your Home Screen">
      <LogoMark size={40} />
      <p class="install-hint__text">
        <strong>Keep Clearcall one tap away.</strong> Tap <IosShareIcon size={16} class="inline-icon" />{" "}
        <span class="visually-hidden">Share</span> then “Add to Home Screen”.
      </p>
      <button
        type="button"
        class="icon-btn"
        data-testid={TID.installHintDismiss}
        aria-label="Dismiss"
        onClick={() => {
          dismissInstallHint();
          setVisible(false);
        }}
      >
        <CloseIcon size={20} />
      </button>
    </aside>
  );
}
