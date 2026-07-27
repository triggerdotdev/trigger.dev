/**
 * Noisy-neighbor load generator for the CK virtual-time END-TO-END A/B arm.
 *
 * Tenant A floods the base queue across MANY concurrency keys (the sharding case
 * a per-key cap cannot fix); tenant B sends a few runs on a couple of keys. Each
 * run carries a per-run `region` so load spreads across the managed worker groups.
 *
 * This instance's runs.list (ClickHouse-backed) is unreliable, so we capture each
 * run id at trigger time via individual tasks.trigger calls (fired with bounded
 * concurrency so they still enqueue near-simultaneously as a backlog) and write a
 * manifest. collect.ts / waitdrain.ts retrieve by id (the Postgres path).
 *
 * Auth (env): TRIGGER_API_URL, TRIGGER_SECRET_KEY (prod env secret key).
 * Config (env): ARM=off|on  BATCH=<id>  HOLD_MS  A_KEYS A_PER_KEY  B_KEYS B_PER_KEY
 *   REGIONS=trigger-regiona,trigger-regionb,trigger-regionc  OUT=./e2e-results
 *   FIRE_CONCURRENCY=30
 */
import { configure, tasks } from "@trigger.dev/sdk";
import { mkdirSync, writeFileSync } from "node:fs";
import type { ckBenchTask } from "./trigger/ckBench.js";

const envInt = (n: string, d: number) =>
  process.env[n] === undefined ? d : Number(process.env[n]);

async function main() {
  const apiURL = process.env.TRIGGER_API_URL;
  const accessToken = process.env.TRIGGER_SECRET_KEY;
  if (!apiURL || !accessToken) throw new Error("Set TRIGGER_API_URL and TRIGGER_SECRET_KEY.");
  configure({ baseURL: apiURL, accessToken });

  const arm = (process.env.ARM ?? "off") as "off" | "on";
  const batch = process.env.BATCH ?? `b${arm}`;
  const holdMs = envInt("HOLD_MS", 1500);
  const aKeys = envInt("A_KEYS", 30);
  const aPerKey = envInt("A_PER_KEY", 8);
  const bKeys = envInt("B_KEYS", 3);
  const bPerKey = envInt("B_PER_KEY", 10);
  const outDir = process.env.OUT ?? "./e2e-results";
  const fireConcurrency = envInt("FIRE_CONCURRENCY", 30);
  const regions = (process.env.REGIONS ?? "trigger-regiona,trigger-regionb,trigger-regionc")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  type Item = { tenant: "A" | "B"; key: string; region: string };
  const items: Item[] = [];
  let n = 0;
  const push = (tenant: "A" | "B", key: string) => {
    items.push({ tenant, key, region: regions[n % regions.length]! });
    n++;
  };
  for (let k = 0; k < aKeys; k++) for (let i = 0; i < aPerKey; i++) push("A", `A-${k}`);
  for (let k = 0; k < bKeys; k++) for (let i = 0; i < bPerKey; i++) push("B", `B-${k}`);
  // interleave so B does not all arrive first
  items.sort((x, y) => x.key.localeCompare(y.key));

  console.log(
    `[loadgen] arm=${arm} batch=${batch} total=${items.length} (A=${aKeys}x${aPerKey}, B=${bKeys}x${bPerKey}) regions=${regions.join(",")} holdMs=${holdMs}`
  );

  const manifest: {
    batch: string;
    arm: string;
    triggeredAt: number;
    runs: { id: string; tenant: string; key: string; region: string }[];
  } = { batch, arm, triggeredAt: Date.now(), runs: [] };

  let idx = 0;
  let failed = 0;
  async function worker() {
    while (idx < items.length) {
      const it = items[idx++]!;
      try {
        const h = await tasks.trigger<typeof ckBenchTask>(
          "ck-bench",
          { holdMs, tenant: it.tenant, key: it.key, arm, batch },
          {
            concurrencyKey: it.key,
            region: it.region,
            tags: ["ckbench", `arm:${arm}`, `tenant:${it.tenant}`, `batch:${batch}`],
          }
        );
        manifest.runs.push({ id: h.id, tenant: it.tenant, key: it.key, region: it.region });
      } catch (e) {
        failed++;
        if (failed <= 3) console.error(`[loadgen] trigger failed:`, (e as Error).message);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(fireConcurrency, items.length) }, worker));

  mkdirSync(outDir, { recursive: true });
  const path = `${outDir}/manifest-${batch}.json`;
  writeFileSync(path, JSON.stringify(manifest, null, 2));
  console.log(
    `[loadgen] triggered ${manifest.runs.length}/${items.length} (failed ${failed}). manifest: ${path}`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
