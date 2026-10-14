/** Network profiles (quality/profiles/*.yaml): parsing, validation and the effective link at a point in time. */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { CorpusId } from "./prepare-media.ts";
import { PROFILES_DIR } from "./util.ts";

export interface LinkState {
  up_kbps: number;
  down_kbps: number;
  delay_ms: number;
  jitter_ms: number;
  loss_pct: number;
  loss_model: "random" | "gilbert";
  /**
   * netem delay distribution for the jitter: normal (default) or a heavy-tailed one — `paretonormal` models Wi-Fi
   * (mostly a few ms, occasional 20–80 ms aggregation/retry spikes), `pareto` is spikier still.
   */
  jitter_distribution?: JitterDistribution;
  /** Egress queue depth in ms at the shaped rate (default 200). Home routers buffer 300–1000 ms (bufferbloat). */
  queue_ms?: number;
}
export type JitterDistribution = "normal" | "pareto" | "paretonormal";
const DISTRIBUTIONS: JitterDistribution[] = ["normal", "pareto", "paretonormal"];
export type LinkStep = Partial<Omit<LinkState, "loss_model" | "jitter_distribution" | "queue_ms">> & {
  at_s: number;
};

export interface Profile {
  name: string;
  link: LinkState;
  /** Changes over time (bw_squeeze). Sorted by at_s. Applied on top of `link`. */
  schedule: LinkStep[];
  topology: "p2p" | "mesh";
  participants: number;
  duration_s: number;
  audio: CorpusId;
  video: CorpusId;
  mode: "voice" | "music";
  seed: number;
}

const AUDIO: CorpusId[] = ["speech_clean", "speech_noisy", "music"];
const VIDEO: CorpusId[] = ["talking_head", "motion"];
const NUM_FIELDS = ["up_kbps", "down_kbps", "delay_ms", "jitter_ms", "loss_pct"] as const;

export class ProfileError extends Error {}

function num(v: unknown, field: string, { min = 0, max = Number.POSITIVE_INFINITY } = {}): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max)
    throw new ProfileError(`${field} must be a number in [${min}, ${max}], got ${JSON.stringify(v)}`);
  return v;
}

export function parseProfile(name: string, text: string): Profile {
  const raw = parse(text) as Record<string, unknown> | null;
  if (!raw || typeof raw !== "object") throw new ProfileError(`${name}: empty profile`);
  const where = (f: string) => `${name}: ${f}`;
  const link = (raw.link ?? {}) as Record<string, unknown>;
  const schedule: LinkStep[] = [];
  if (link.schedule !== undefined) {
    if (!Array.isArray(link.schedule)) throw new ProfileError(where("link.schedule must be a list"));
    for (const [i, s] of (link.schedule as Record<string, unknown>[]).entries()) {
      const step: LinkStep = { at_s: num(s.at_s, where(`link.schedule[${i}].at_s`)) };
      for (const f of NUM_FIELDS)
        if (s[f] !== undefined)
          step[f] = num(s[f], where(`link.schedule[${i}].${f}`), f === "loss_pct" ? { max: 100 } : {});
      schedule.push(step);
    }
    schedule.sort((a, b) => a.at_s - b.at_s);
  }
  const atZero = schedule.find((s) => s.at_s === 0);
  const pick = (f: (typeof NUM_FIELDS)[number], dflt?: number): number => {
    const v = link[f] ?? atZero?.[f] ?? dflt;
    if (v === undefined)
      throw new ProfileError(where(`link.${f} is required (or in a schedule step at_s: 0)`));
    return num(v, where(`link.${f}`), f === "loss_pct" ? { max: 100 } : {});
  };
  const lossModel = link.loss_model ?? "random";
  if (lossModel !== "random" && lossModel !== "gilbert")
    throw new ProfileError(where(`link.loss_model must be random|gilbert, got ${String(lossModel)}`));

  const dist = link.jitter_distribution ?? "normal";
  if (!DISTRIBUTIONS.includes(dist as JitterDistribution))
    throw new ProfileError(where(`link.jitter_distribution must be ${DISTRIBUTIONS.join("|")}`));
  const queueMs =
    link.queue_ms === undefined
      ? undefined
      : num(link.queue_ms, where("link.queue_ms"), { min: 10, max: 5000 });

  const topology = raw.topology ?? "p2p";
  if (topology !== "p2p" && topology !== "mesh") throw new ProfileError(where("topology must be p2p|mesh"));
  const participants =
    topology === "p2p"
      ? 2
      : num(raw.participants ?? 4, where("participants"), {
          min: 2,
          max: 10,
        });
  if (topology === "p2p" && raw.participants !== undefined && raw.participants !== 2)
    throw new ProfileError(where("p2p topology has exactly 2 participants"));

  const corpus = (raw.corpus ?? []) as unknown[];
  if (!Array.isArray(corpus)) throw new ProfileError(where("corpus must be a list"));
  for (const c of corpus)
    if (!AUDIO.includes(c as CorpusId) && !VIDEO.includes(c as CorpusId))
      throw new ProfileError(where(`unknown corpus "${String(c)}"`));
  const audios = corpus.filter((c) => AUDIO.includes(c as CorpusId)) as CorpusId[];
  const videos = corpus.filter((c) => VIDEO.includes(c as CorpusId)) as CorpusId[];
  if (audios.length > 1 || videos.length > 1)
    throw new ProfileError(where("corpus: at most one audio and one video"));

  const mode = raw.mode ?? "voice";
  if (mode !== "voice" && mode !== "music") throw new ProfileError(where("mode must be voice|music"));

  return {
    name,
    link: {
      up_kbps: pick("up_kbps"),
      down_kbps: pick("down_kbps"),
      delay_ms: pick("delay_ms", 0),
      jitter_ms: pick("jitter_ms", 0),
      loss_pct: pick("loss_pct", 0),
      loss_model: lossModel,
      ...(dist !== "normal" ? { jitter_distribution: dist as JitterDistribution } : {}),
      ...(queueMs !== undefined ? { queue_ms: queueMs } : {}),
    },
    schedule,
    topology,
    participants,
    duration_s: num(raw.duration_s ?? 60, where("duration_s"), { min: 10, max: 3600 }),
    audio: audios[0] ?? (mode === "music" ? "music" : "speech_clean"),
    video: videos[0] ?? "talking_head",
    mode,
    seed: num(raw.seed ?? 1, where("seed")),
  };
}

/** Effective link at time t (seconds since session start). */
export function linkAt(p: Profile, t: number): LinkState {
  let state = { ...p.link };
  for (const s of p.schedule) {
    if (s.at_s > t) break;
    const { at_s: _, ...rest } = s;
    state = { ...state, ...rest };
  }
  return state;
}

/** Times (s) at which the link changes, excluding 0. */
export function changePoints(p: Profile): number[] {
  return [...new Set(p.schedule.map((s) => s.at_s).filter((t) => t > 0))];
}

export function listProfiles(dir = PROFILES_DIR): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => f.replace(/\.yaml$/, ""))
    .sort();
}

export function loadProfile(name: string, dir = PROFILES_DIR): Profile {
  return parseProfile(name, readFileSync(join(dir, `${name}.yaml`), "utf8"));
}
