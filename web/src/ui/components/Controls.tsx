import type { ComponentChildren } from "preact";
import { TID } from "../../core/testids.ts";
import type { CallController, LocalParticipant } from "../../core/types.ts";
import {
  CamIcon,
  CamOffIcon,
  FlipIcon,
  LeaveIcon,
  MicIcon,
  MicOffIcon,
  MoreIcon,
  ShareIcon,
} from "../icons.tsx";
import { shareWithFeedback } from "../toast.ts";

/** Round control button. `off` = the inverted look used for a muted mic / camera off. */
export function CtlButton(props: {
  testid: string;
  label: string;
  pressed?: boolean;
  off?: boolean;
  danger?: boolean;
  disabled?: boolean;
  expanded?: boolean;
  onClick: () => void;
  children: ComponentChildren;
}) {
  const cls = ["ctl", props.off ? "ctl--off" : "", props.danger ? "ctl--danger" : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      type="button"
      class={cls}
      data-testid={props.testid}
      aria-label={props.label}
      aria-pressed={props.pressed}
      aria-expanded={props.expanded}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

export function MicButton({ c, local }: { c: CallController; local: LocalParticipant }) {
  const on = local.micOn && local.micAvailable;
  return (
    <CtlButton
      testid={TID.micToggle}
      label="Mute"
      pressed={!on}
      off={!on}
      disabled={!local.micAvailable}
      onClick={() => c.setMic(!local.micOn)}
    >
      {on ? <MicIcon /> : <MicOffIcon />}
    </CtlButton>
  );
}

export function CamButton({ c, local }: { c: CallController; local: LocalParticipant }) {
  const on = local.camOn && local.camAvailable;
  return (
    <CtlButton
      testid={TID.camToggle}
      label="Camera off"
      pressed={!on}
      off={!on}
      disabled={!local.camAvailable}
      onClick={() => void c.setCam(!local.camOn)}
    >
      {on ? <CamIcon /> : <CamOffIcon />}
    </CtlButton>
  );
}

export function FlipButton({ c, local }: { c: CallController; local: LocalParticipant }) {
  return (
    <CtlButton
      testid={TID.flipCamera}
      label={local.facing === "user" ? "Switch to back camera" : "Switch to front camera"}
      disabled={!local.camOn}
      onClick={() => void c.switchCamera()}
    >
      <FlipIcon />
    </CtlButton>
  );
}

export function ControlsBar(props: {
  c: CallController;
  local: LocalParticipant;
  showShare: boolean;
  moreOpen: boolean;
  onMore: () => void;
}) {
  const { c, local } = props;
  return (
    <div class="controls" role="toolbar" aria-label="Call controls">
      <MicButton c={c} local={local} />
      <CamButton c={c} local={local} />
      {local.canSwitchCamera && <FlipButton c={c} local={local} />}
      {props.showShare && (
        <CtlButton
          testid={TID.shareLink}
          label="Share link"
          onClick={() => void shareWithFeedback(() => c.shareLink())}
        >
          <ShareIcon />
        </CtlButton>
      )}
      <CtlButton testid={TID.moreMenu} label="More options" expanded={props.moreOpen} onClick={props.onMore}>
        <MoreIcon />
      </CtlButton>
      <CtlButton testid={TID.leaveButton} label="Leave call" danger onClick={() => c.leave()}>
        <LeaveIcon />
      </CtlButton>
    </div>
  );
}
