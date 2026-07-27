/**
 * Collect per-tenant enqueue->start latency for one END-TO-END arm.
 *
 * Lists the runs for a batch by tag, reads each run's createdAt (enqueue) and
 * startedAt (execution start), and reports per-tenant p50/p95/p99 of
 * (startedAt - createdAt). Run once per arm; point --arm/BATCH at the tags the
 * loadgen used.
 *
 * The headline metric is tenant B's start latency: under the baseline it should
 * grow with tenant A's backlog (B waits behind the flood); under vtime it should
 * stay bounded (B takes its fair turn). Tenant A's latency is reported for
 * context and is expected to be similar or slightly higher under vtime.
 *
 * NOTE ON THE TIMESTAMP: startedAt - createdAt is the honest run-start latency a
 * reviewer cares about (queue wait + dequeue + worker pickup). For a tighter
 * dequeue-only number, use the Postgres/TRQL alternative in the benchmark doc.
 *
 * Auth + config (env):
 *   TRIGGER_API_URL, TRIGGER_SECRET_KEY (prod env secret key)
 *   ARM=off|on   BATCH=<id>   OUT=./e2e-results
 */
import { configure, runs } from "@trigger.dev/sdk";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";

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
  const apiURL = process.env.TRIGGER_API_URL;
  const accessToken = process.env.TRIGGER_SECRET_KEY;
  if (!apiURL || !accessToken) throw new Error("Set TRIGGER_API_URL and TRIGGER_SECRET_KEY.");
  configure({ baseURL: apiURL, accessToken });

  const arm = (process.env.ARM ?? "off") as "off" | "on";
  const batch = process.env.BATCH;
  const outDir = process.env.OUT ?? "./e2e-results";
  if (!batch) throw new Error("Set BATCH=<id> to the loadgen batch id.");

  const waitsByTenant = new Map<string, number[]>();
  let total = 0;
  let missingStart = 0;

  // Page through every run carrying this batch tag. BATCH is unique per arm
  // (e.g. off-1 / on-1), so the single batch tag identifies the arm; filtering
  // on one tag avoids any multi-tag AND/OR ambiguity in the runs filter.
  for await (const run of runs.list({ tag: `batch:${batch}`, limit: 100 })) {
    total++;
    const detail = await runs.retrieve(run.id);
    const createdAt = detail.createdAt?.getTime();
    const startedAt = detail.startedAt?.getTime();
    if (createdAt === undefined || startedAt === undefined) {
      missingStart++;
      continue;
    }
    const tenantTag = (detail.tags ?? []).find((t) => t.startsWith("tenant:")) ?? "tenant:?";
    const tenant = tenantTag.slice("tenant:".length);
    const wait = startedAt - createdAt;
    (waitsByTenant.get(tenant) ?? waitsByTenant.set(tenant, []).get(tenant)!).push(wait);
  }

  const perTenant: Record<string, ReturnType<typeof summarize>> = {};
  for (const [tenant, xs] of waitsByTenant) perTenant[tenant] = summarize(xs);

  const report = { arm, batch, total, missingStart, unit: "ms (startedAt - createdAt)", perTenant };

  mkdirSync(outDir, { recursive: true });
  writeFileSync(`${outDir}/e2e-${batch}-${arm}.json`, JSON.stringify(report, null, 2));

  // Append a human row per tenant to a shared markdown file so OFF and ON land
  // in one table you can eyeball before running the joiner.
  const mdPath = `${outDir}/e2e-summary.md`;
  const rows = Object.entries(perTenant)
    .map(
      ([tenant, s]) =>
        `| ${batch} | ${arm} | ${tenant} | ${s.count} | ${s.mean.toFixed(0)} | ${s.p50.toFixed(0)} | ${s.p95.toFixed(0)} | ${s.p99.toFixed(0)} |`
    )
    .join("\n");
  appendFileSync(
    mdPath,
    `\n<!-- batch ${batch} arm ${arm} -->\n| batch | arm | tenant | runs | mean ms | p50 | p95 | p99 |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n${rows}\n`
  );

  console.log(`[collect] arm=${arm} batch=${batch} runs=${total} missingStart=${missingStart}`);
  console.log(JSON.stringify(perTenant, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
