/**
 * Collect per-tenant enqueue->start latency for one END-TO-END arm, from a batch
 * manifest (retrieve by id; runs.list is unreliable on this instance).
 *
 * Metric per run = startedAt - createdAt (run-start latency: queue wait + dequeue
 * + worker pickup). Headline is tenant B (few keys): bounded under vtime, grows
 * with A's backlog under baseline.
 *
 * Env: TRIGGER_API_URL, TRIGGER_SECRET_KEY.  Args (env): BATCH ARM OUT POLL_CONCURRENCY
 */
import { configure, runs } from "@trigger.dev/sdk";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}
function summarize(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const mean = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
  return { count: xs.length, mean, p50: pct(s, 50), p95: pct(s, 95), p99: pct(s, 99) };
}

async function main() {
  configure({
    baseURL: process.env.TRIGGER_API_URL!,
    accessToken: process.env.TRIGGER_SECRET_KEY!,
  });
  const batch = process.env.BATCH!;
  const arm = (process.env.ARM ?? "off") as "off" | "on";
  const outDir = process.env.OUT ?? "./e2e-results";
  const conc = Number(process.env.POLL_CONCURRENCY ?? "20");
  const manifest = JSON.parse(readFileSync(`${outDir}/manifest-${batch}.json`, "utf8"));
  const entries: { id: string; tenant: string }[] = manifest.runs;

  const waitsByTenant = new Map<string, number[]>();
  let missingStart = 0;
  let i = 0;
  async function w() {
    while (i < entries.length) {
      const e = entries[i++]!;
      try {
        const r = await runs.retrieve(e.id);
        const c = r.createdAt?.getTime();
        const s = r.startedAt?.getTime();
        if (c === undefined || s === undefined) {
          missingStart++;
          continue;
        }
        const arr = waitsByTenant.get(e.tenant) ?? waitsByTenant.set(e.tenant, []).get(e.tenant)!;
        arr.push(s - c);
      } catch {
        missingStart++;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(conc, entries.length) }, w));

  const perTenant: Record<string, ReturnType<typeof summarize>> = {};
  for (const [t, xs] of waitsByTenant) perTenant[t] = summarize(xs);
  const report = {
    arm,
    batch,
    total: entries.length,
    missingStart,
    unit: "ms (startedAt - createdAt)",
    perTenant,
  };

  mkdirSync(outDir, { recursive: true });
  writeFileSync(`${outDir}/e2e-${batch}-${arm}.json`, JSON.stringify(report, null, 2));

  const rows = Object.entries(perTenant)
    .map(
      ([t, s]) =>
        `| ${batch} | ${arm} | ${t} | ${s.count} | ${s.mean.toFixed(0)} | ${s.p50.toFixed(0)} | ${s.p95.toFixed(0)} | ${s.p99.toFixed(0)} |`
    )
    .join("\n");
  appendFileSync(
    `${outDir}/e2e-summary.md`,
    `\n<!-- batch ${batch} arm ${arm} -->\n| batch | arm | tenant | runs | mean ms | p50 | p95 | p99 |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n${rows}\n`
  );
  console.log(
    `[collect] arm=${arm} batch=${batch} runs=${entries.length} missingStart=${missingStart}`
  );
  console.log(JSON.stringify(perTenant, null, 2));
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
