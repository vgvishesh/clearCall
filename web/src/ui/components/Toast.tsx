import { toast } from "../toast.ts";

export function Toast() {
  const t = toast.value;
  return (
    <div class="toast-region" role="status" aria-live="polite">
      {t && (
        <div class="toast" key={t.id}>
          {t.text}
        </div>
      )}
    </div>
  );
}
