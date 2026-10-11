import type { ComponentChildren } from "preact";
import { useId } from "preact/hooks";

/** A full-width row with a label, a one-line description and an on/off switch. The whole row is the control. */
export function SwitchRow(props: {
  checked: boolean;
  onChange: (on: boolean) => void;
  label: string;
  description?: string;
  icon?: ComponentChildren;
  testid?: string;
  disabled?: boolean;
}) {
  const descId = useId();
  return (
    <button
      type="button"
      role="switch"
      class="switch-row"
      aria-checked={props.checked}
      aria-describedby={props.description ? descId : undefined}
      data-testid={props.testid}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
    >
      {props.icon && <span class="switch-row__icon">{props.icon}</span>}
      <span class="switch-row__text">
        <span class="switch-row__label">{props.label}</span>
        {props.description && (
          <span class="switch-row__desc" id={descId}>
            {props.description}
          </span>
        )}
      </span>
      <span class={props.checked ? "switch is-on" : "switch"} aria-hidden="true">
        <span class="switch__knob" />
      </span>
    </button>
  );
}
