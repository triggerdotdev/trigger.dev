/**
 * Noisy-neighbor load generator for the CK virtual-time END-TO-END A/B arm.
 *
 * Triggers the deployed `ck-bench` task on a self-hosted instance. Tenant A
 * floods the base queue across MANY concurrency keys (the sharding/sybil case a
 * per-key cap cannot fix); tenant B sends a few runs on a couple of keys. Each
 * run is tagged so `collect.ts` can measure per-tenant enqueue->start latency,
 * and each run carries a per-run `region` so the load spreads across the managed
 * worker groups (multi-cluster placement).
 *
 * This does NOT flip the feature flag: the flag is server-side (see the operator
 * runbook). Run this once per arm AFTER the operator has set the flag and
 * redeployed the control plane, passing the matching --arm so the tags line up.
 *
 * Auth (from env):
 *   TRIGGER_API_URL       e.g. https://<instance>
 *   TRIGGER_SECRET_KEY    the PROD environment secret key of the bench project
 *
 * Config (from env, with defaults):
 *   ARM=off|on            tag only; must match the server flag state
 *   BATCH=<id>            unique per A/B run pair (defaults to a timestamp)
 *   HOLD_MS=1500          per-run slot hold
 *   A_KEYS=40 A_PER_KEY=5 tenant A flood shape
 *   B_KEYS=2  B_PER_KEY=5 tenant B light shape
 *   REGIONS=trigger-regiona,trigger-regionb,trigger-regionc
 *                         runs are round-robined across these worker groups
 */
import { configure, tasks } from "@trigger.dev/sdk";
import type { ckBenchTask } from "./trigger/ckBench.js";

function envInt(name: string, dflt: number): number {
  const v = process.env[name];
  return v === undefined ? dflt : Number(v);
}

async function main() {
  const apiURL = process.env.TRIGGER_API_URL;
  const accessToken = process.env.TRIGGER_SECRET_KEY;
  if (!apiURL || !accessToken) {
    throw new Error("Set TRIGGER_API_URL and TRIGGER_SECRET_KEY (prod env secret key).");
  }
  configure({ baseURL: apiURL, accessToken });

  const arm = (process.env.ARM ?? "off") as "off" | "on";
  const batch = process.env.BATCH ?? `b${Date.now()}`;
  const holdMs = envInt("HOLD_MS", 1500);
  const aKeys = envInt("A_KEYS", 40);
  const aPerKey = envInt("A_PER_KEY", 5);
  const bKeys = envInt("B_KEYS", 2);
  const bPerKey = envInt("B_PER_KEY", 5);
  const regions = (process.env.REGIONS ?? "trigger-regiona,trigger-regionb,trigger-regionc")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  type Item = {
    payload: { holdMs: number; tenant: string; key: string; arm: "off" | "on"; batch: string };
    options: { concurrencyKey: string; region: string; tags: string[] };
  };

  const items: Item[] = [];
  let n = 0;
  const push = (tenant: "A" | "B", key: string) => {
    const region = regions[n % regions.length]!;
    n++;
    items.push({
      payload: { holdMs, tenant, key, arm, batch },
      options: {
        concurrencyKey: key,
        region,
        tags: [`ckbench`, `arm:${arm}`, `tenant:${tenant}`, `batch:${batch}`],
      },
    });
  };

  for (let k = 0; k < aKeys; k++) for (let i = 0; i < aPerKey; i++) push("A", `A-${k}`);
  for (let k = 0; k < bKeys; k++) for (let i = 0; i < bPerKey; i++) push("B", `B-${k}`);

  // Interleave A and B enqueues so B does not simply arrive first; the point is
  // whether B's few runs start promptly WHILE A's flood is queued.
  items.sort((x, y) => x.payload.key.localeCompare(y.payload.key));

  console.log(
    `[loadgen] arm=${arm} batch=${batch} total=${items.length} (A=${aKeys}x${aPerKey}, B=${bKeys}x${bPerKey}) regions=${regions.join(",")} holdMs=${holdMs}`
  );

  const handle = await tasks.batchTrigger<typeof ckBenchTask>(
    "ck-bench",
    items.map((it) => ({ payload: it.payload, options: it.options }))
  );

  console.log(
    `[loadgen] batch triggered: ${handle.batchId} (${items.length} runs). BATCH=${batch}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
