import { useState } from "preact/hooks";
import { TID } from "../../core/testids.ts";
import { useCall } from "../context.ts";
import { ArrowRightIcon, LogoMark, VideoPlusIcon } from "../icons.tsx";

/** `/` — one primary action. Pasting a link is the only alternative. */
export function Home() {
  const c = useCall();
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);

  const start = async () => {
    setBusy(true);
    try {
      await c.prepare({});
    } finally {
      setBusy(false);
    }
  };
  const join = (e: Event) => {
    e.preventDefault();
    const value = link.trim();
    if (value) void c.prepare({ link: value });
  };

  return (
    <main class="screen home">
      <header class="home__brand">
        <LogoMark size={32} />
        <span class="wordmark">Clearcall</span>
      </header>
      <section class="home__hero">
        <h1 class="home__title">Crystal-clear calls.</h1>
        <p class="home__lead">Just share a link.</p>
      </section>
      <section class="home__actions">
        <button
          type="button"
          class="btn btn--primary btn--block"
          data-testid={TID.startCall}
          onClick={start}
          disabled={busy}
        >
          <VideoPlusIcon />
          Start a call
        </button>
        <form class="link-form" onSubmit={join}>
          <label class="visually-hidden" for="join-link">
            Call link
          </label>
          <input
            id="join-link"
            class="input link-form__input"
            data-testid={TID.joinLinkInput}
            type="text"
            inputMode="url"
            autocomplete="off"
            autocapitalize="off"
            spellcheck={false}
            enterKeyHint="go"
            placeholder="Have a link? Paste it"
            value={link}
            onInput={(e) => setLink(e.currentTarget.value)}
          />
          <button
            type="submit"
            class="link-form__submit"
            data-testid={TID.joinLinkSubmit}
            aria-label="Join with link"
            disabled={!link.trim()}
          >
            <span class="link-form__submit-text">Join</span>
            <ArrowRightIcon size={20} />
          </button>
        </form>
      </section>
    </main>
  );
}
