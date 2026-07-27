/**
 * Region preflight: trigger one ck-bench run per worker group and confirm each
 * starts (validates region routing + isWorkerGroupAllowedForProject before the
 * real load). Reads TRIGGER_API_URL / TRIGGER_SECRET_KEY from env.
 */
import { configure, runs, tasks } from "@trigger.dev/sdk";
import type { ckBenchTask } from "./trigger/ckBench.js";

const regions = ["trigger-regiona", "trigger-regionb", "trigger-regionc"];

async function main() {
  configure({
    baseURL: process.env.TRIGGER_API_URL!,
    accessToken: process.env.TRIGGER_SECRET_KEY!,
  });

  const handles: { region: string; id: string }[] = [];
  for (const region of regions) {
    const h = await tasks.trigger<typeof ckBenchTask>(
      "ck-bench",
      { holdMs: 2000, tenant: "preflight", key: `pf-${region}`, arm: "on", batch: "preflight" },
      { concurrencyKey: `pf-${region}`, region, tags: ["ckbench", "preflight", `region:${region}`] }
    );
    handles.push({ region, id: h.id });
    console.log(`[preflight] triggered ${region}: ${h.id}`);
  }

  // Poll up to ~90s for each to leave the queue and reach a terminal/executing state.
  const deadline = Date.now() + 90_000;
  const seen = new Map<string, string>();
  while (Date.now() < deadline && seen.size < handles.length) {
    for (const { region, id } of handles) {
      if (seen.has(id)) continue;
      const r = await runs.retrieve(id);
      if (["EXECUTING", "COMPLETED", "FAILED", "CRASHED", "SYSTEM_FAILURE"].includes(r.status)) {
        seen.set(id, r.status);
        const started = r.startedAt ? r.startedAt.getTime() - r.createdAt.getTime() : undefined;
        console.log(
          `[preflight] ${region} ${id} -> ${r.status}${started !== undefined ? ` (start wait ${started}ms)` : ""}`
        );
      }
    }
    if (seen.size < handles.length) await new Promise((r) => setTimeout(r, 3000));
  }

  const stuck = handles.filter((h) => !seen.has(h.id));
  if (stuck.length) {
    console.log(
      `[preflight] STILL QUEUED after 90s (possible access/routing issue): ${stuck.map((s) => `${s.region}:${s.id}`).join(", ")}`
    );
    process.exit(2);
  }
  console.log("[preflight] all regions accepted + started. Routing + access OK.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
