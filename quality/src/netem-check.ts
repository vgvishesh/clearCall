/**
 * Verifies the netem shaping commands on the local Docker VM with two tiny alpine containers (no Playwright
 * image needed): applies a profile's egress + ifb ingress shaping to both, pings across, and compares the
 * measured RTT/loss with the profile.
 *
 *   pnpm --filter @clearcall/quality exec tsx src/netem-check.ts [--profile 3g_lossy] [--count 200]
 */
import { dockerAvailable, egressNetem, ingressSetup, NETWORK } from "./netem.ts";
import { linkAt, loadProfile } from "./profiles.ts";
import { log, parseArgs, run } from "./util.ts";

async function main(): Promise<number> {
  const a = parseArgs(process.argv.slice(2));
  const profile = loadProfile(a.get("profile") ?? "4g_typical");
  const count = Number(a.get("count") ?? 100);
  const d = await dockerAvailable();
  if (!d.ok) {
    console.error(d.why);
    return 2;
  }
  const link = linkAt(profile, 0);
  const names = ["clearcall-netem-check-a", "clearcall-netem-check-b"];
  await run("docker", ["network", "create", NETWORK], { allowFail: true });
  try {
    for (const n of names) {
      await run("docker", ["rm", "-f", n], { allowFail: true });
      await run("docker", [
        "run",
        "-d",
        "--rm",
        "--name",
        n,
        "--network",
        NETWORK,
        "--cap-add",
        "NET_ADMIN",
        "alpine:3",
        "sleep",
        "600",
      ]);
      await run("docker", ["exec", n, "apk", "add", "--no-cache", "-q", "iproute2", "iputils"]);
      await run("docker", ["exec", n, ...egressNetem(link, "add")]);
    }
    let ifb = true;
    for (const c of ingressSetup(link)) {
      const r = await run("docker", ["exec", names[0]!, ...c], { allowFail: true });
      if (r.code !== 0) {
        ifb = false;
        log(`ifb ingress shaping unavailable: ${r.stderr.trim()}`);
        break;
      }
    }
    log(`pinging ${count}× with ${profile.name} shaping on both sides`);
    const r = await run(
      "docker",
      ["exec", names[0]!, "ping", "-q", "-i", "0.05", "-c", String(count), names[1]!],
      {
        allowFail: true,
      },
    );
    const loss = Number(/([\d.]+)% packet loss/.exec(r.stdout)?.[1]);
    const [min, avg, max] = (/= ([\d.]+)\/([\d.]+)\/([\d.]+)/.exec(r.stdout) ?? []).slice(1).map(Number);
    // Each ICMP round trip crosses 2 egress qdiscs (a→b, b→a) → expected RTT ≈ 2·delay, loss ≈ 1-(1-L)².
    const expRtt = 2 * link.delay_ms;
    const expLoss = 100 * (1 - (1 - link.loss_pct / 100) ** 2);
    const out = {
      profile: profile.name,
      expected: { rtt_ms: expRtt, loss_pct: Number(expLoss.toFixed(2)) },
      measured: { rtt_min: min, rtt_avg: avg, rtt_max: max, loss_pct: loss },
      ifb_ingress: ifb,
      egress_cmd: egressNetem(link, "add").join(" "),
    };
    console.log(JSON.stringify(out, null, 2));
    const ok = avg !== undefined && Math.abs(avg - expRtt) <= Math.max(10, 0.25 * expRtt);
    log(ok ? "netem-check PASS (RTT within tolerance)" : "netem-check FAIL");
    return ok ? 0 : 1;
  } finally {
    for (const n of names) await run("docker", ["rm", "-f", n], { allowFail: true });
  }
}

main().then(
  (c) => process.exit(c),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(2);
  },
);
