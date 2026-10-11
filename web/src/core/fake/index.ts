/** Entry for the lazily loaded fake engine (`?fake=1`). Never import this statically from main.tsx. */
import { FakeCallController } from "./FakeCallController.ts";
import { buildScenario, type UiHints } from "./scenarios.ts";

export { FakeCallController } from "./FakeCallController.ts";
export { SCENARIO_NAMES } from "./scenarios.ts";

export function createFakeSetup(scenario: string): { controller: FakeCallController; hints: UiHints } {
  const s = buildScenario(scenario);
  return { controller: new FakeCallController(s.options), hints: s.hints ?? {} };
}
