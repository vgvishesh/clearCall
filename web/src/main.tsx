import { render } from "preact";
import { createCallController } from "./core/controller.ts";
import type { CallController } from "./core/types.ts";
import { App } from "./ui/App.tsx";
import "./ui/tokens.css";
import "./ui/app.css";

const root = document.getElementById("app")!;
const params = new URLSearchParams(location.search);

async function boot() {
  if (params.get("fake") === "1") {
    // FakeCallController + canvas media live in their own chunk: never part of a normal first load.
    const { createFakeSetup } = await import("./core/fake/index.ts");
    const fake = createFakeSetup(params.get("scenario") ?? "home");
    render(<App controller={fake.controller} hints={fake.hints} />, root);
    return;
  }
  let controller: CallController | null = null;
  try {
    controller = createCallController();
  } catch (err) {
    console.error("[clearcall] call engine failed to start", err);
  }
  render(<App controller={controller} />, root);
}

void boot();
