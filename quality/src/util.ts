/** Paths and process helpers shared by the lab tools. */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const QUALITY_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const ROOT_DIR = resolve(QUALITY_DIR, "..");
export const CACHE_DIR = join(QUALITY_DIR, ".cache");
export const MEDIA_DIR = join(CACHE_DIR, "media");
export const MODELS_DIR = join(CACHE_DIR, "models");
export const REPORTS_DIR = join(QUALITY_DIR, "reports");
export const PROFILES_DIR = join(QUALITY_DIR, "profiles");
export const SCORERS_DIR = join(QUALITY_DIR, "scorers");
export const DEV_LOG = join(ROOT_DIR, ".claude", "state", "logs", "dev-server.log");

export function ensureDir(p: string): string {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
  return p;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a command, capture output. Rejects on non-zero exit unless `allowFail`. */
export function run(
  cmd: string,
  args: string[],
  opts: { allowFail?: boolean; cwd?: string; input?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> {
  return new Promise((res, rej) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", rej);
    child.on("close", (code) => {
      const r = { code: code ?? -1, stdout, stderr };
      if (r.code !== 0 && !opts.allowFail)
        rej(new Error(`${cmd} ${args.join(" ")} → exit ${r.code}\n${stderr.slice(-2000)}`));
      else res(r);
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

export async function have(cmd: string): Promise<boolean> {
  return (await run("sh", ["-c", `command -v ${cmd}`], { allowFail: true })).code === 0;
}

/** `YYYYMMDD-HHMMSS` in local time, for report directory names. */
export function timestamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function log(msg: string): void {
  process.stderr.write(`▸ ${msg}\n`);
}

/** Minimal `--key value` / `--flag` parser. Repeated keys collect into arrays via `all()`. */
export function parseArgs(argv: string[]) {
  const map = new Map<string, string[]>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") continue;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const [k, v] =
        eq > 0
          ? [a.slice(2, eq), a.slice(eq + 1)]
          : [a.slice(2), argv[i + 1]?.startsWith("--") ? "true" : argv[++i]];
      map.set(k, [...(map.get(k) ?? []), v ?? "true"]);
    } else if (/^[A-Z_]+=/.test(a)) {
      // make-style KEY=VALUE (scripts/diag.sh passes N=4 DURATION=60)
      const eq = a.indexOf("=");
      map.set(a.slice(0, eq).toLowerCase(), [a.slice(eq + 1)]);
    } else positional.push(a);
  }
  return {
    positional,
    get: (k: string): string | undefined => map.get(k)?.at(-1),
    all: (k: string): string[] => map.get(k) ?? [],
    has: (k: string): boolean => map.has(k),
  };
}
