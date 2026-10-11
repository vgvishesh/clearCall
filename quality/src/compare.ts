/**
 * Diff two lab reports (baseline vs candidate).
 *
 *   pnpm --filter @clearcall/quality compare <base> <cand> [--json] [--fail-on-loss]
 * <base>/<cand> = a report directory (quality/reports/<ts>-<profile>/) or its report.json.
 * Prints a Markdown table + overall verdict (win / loss / trade-off / no-change). Within-noise deltas
 * (VMAF ±1, MOS ±0.05, kbps ±3 %) count as "same" — repeat runs 3× when it matters (quality-lab skill).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { diffReports, type LabReport, renderDiff } from "./report.ts";
import { parseArgs } from "./util.ts";

export function readReport(p: string): LabReport {
  const file = existsSync(p) && statSync(p).isDirectory() ? join(p, "report.json") : p;
  if (!existsSync(file)) throw new Error(`no report at ${file}`);
  return JSON.parse(readFileSync(file, "utf8")) as LabReport;
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  const [b, c] = a.positional;
  if (!b || !c) {
    console.error("usage: compare <base-report> <candidate-report> [--json] [--fail-on-loss]");
    process.exit(2);
  }
  const d = diffReports(readReport(b), readReport(c));
  console.log(a.has("json") ? JSON.stringify(d, null, 2) : renderDiff(d, b, c));
  if (a.has("fail-on-loss") && d.overall === "loss") process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(2);
  }
}
