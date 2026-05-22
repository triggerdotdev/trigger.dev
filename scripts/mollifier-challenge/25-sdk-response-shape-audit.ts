// Phase 5.6 — SDK response shape audit.
//
// Each method below has a buffered branch on the server. The audit
// hits the real local webapp via the actual SDK so the response Zod
// schemas execute against a buffered-run response. zodfetch throws on
// a schema mismatch — a thrown error here is the regression signal
// the Phase 4 audit's two known drifts (idempotencyKey: null →
// undefined, parentId: undefined → null) would have surfaced if this
// script had existed earlier.
//
// Usage (from references/hello-world to get the workspace SDK):
//   cd references/hello-world
//   pnpm exec tsx ../../scripts/mollifier-challenge/25-sdk-response-shape-audit.ts
//
// Pre-reqs:
//   • Webapp running at TRIGGER_API_URL (default http://localhost:3030)
//   • Mollifier configured to buffer every trigger (e.g. TRIP_THRESHOLD=0)
//   • Drainer OFF so the buffered runs stay buffered
//
// Exits 1 on any Zod or HTTP failure.

import { ApiClient } from "@trigger.dev/core/v3";

const apiUrl = process.env.TRIGGER_API_URL ?? "http://localhost:3030";
const secretKey = process.env.TRIGGER_SECRET_KEY ?? "tr_dev_XVYfgsDzhCZRt2dgcbmN";
const taskId = process.env.TASK_ID ?? "hello-world";

const apiClient = new ApiClient(apiUrl, secretKey);

type Result = { name: string; ok: boolean; err?: string };
const results: Result[] = [];

async function check<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    const out = await fn();
    results.push({ name, ok: true });
    return out;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ name, ok: false, err: msg });
    return undefined;
  }
}

async function triggerBuffered(label: string): Promise<{ runId: string }> {
  // SDK trigger via apiClient — exercises triggerTask's response shape
  // as a side benefit. The shape includes the synthesised result for
  // buffered triggers (mollifier.queued notice, isCached, etc.).
  const handle = await apiClient.triggerTask(taskId, {
    payload: { message: `phase5-6-audit-${label}` },
  });
  return { runId: handle.id };
}

async function main() {
  console.log(`audit target: ${apiUrl}`);

  // Single buffered run for the non-destructive reads + metadata/tags mutations.
  const reads = await triggerBuffered("reads");
  console.log(`buffered run for reads: ${reads.runId}`);

  await check("retrieveRun", () => apiClient.retrieveRun(reads.runId));
  // Capture the run's root spanId from the trace response — it's not
  // on RetrieveRunResponse by design, so we have to walk the trace
  // tree. The audit also catches Zod drift on the trace response by
  // making the call.
  const trace = await check("retrieveRunTrace", () =>
    apiClient.retrieveRunTrace(reads.runId),
  );
  // RetrieveRunTraceSpan exposes the span identifier as `id` (not
  // `spanId`); the retrieveSpan endpoint takes it as `spanId` in the
  // URL path.
  const rootSpanId = trace?.trace.rootSpan.id;
  if (rootSpanId) {
    await check("retrieveSpan", () => apiClient.retrieveSpan(reads.runId, rootSpanId));
  } else {
    results.push({
      name: "retrieveSpan",
      ok: false,
      err: "trace.rootSpan.id missing from retrieveRunTrace response",
    });
  }
  await check("listRunEvents", () => apiClient.listRunEvents(reads.runId));
  await check("addTags", () =>
    apiClient.addTags(reads.runId, { tags: ["phase5-6-audit"] }),
  );
  await check("updateRunMetadata", () =>
    apiClient.updateRunMetadata(reads.runId, { metadata: { audit: true } }),
  );

  // Destructive paths need fresh buffered runs.
  const replayRun = await triggerBuffered("replay");
  console.log(`buffered run for replay: ${replayRun.runId}`);
  await check("replayRun", () => apiClient.replayRun(replayRun.runId));

  const rescheduleRunHandle = await triggerBuffered("reschedule");
  console.log(`buffered run for reschedule: ${rescheduleRunHandle.runId}`);
  const futureIso = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  await check("rescheduleRun", () =>
    apiClient.rescheduleRun(rescheduleRunHandle.runId, { delay: futureIso }),
  );

  const cancelRun = await triggerBuffered("cancel");
  console.log(`buffered run for cancel: ${cancelRun.runId}`);
  await check("cancelRun", () => apiClient.cancelRun(cancelRun.runId));

  console.log("");
  let failed = 0;
  for (const r of results) {
    if (r.ok) {
      console.log(`  ✓ ${r.name}`);
    } else {
      console.log(`  ✗ ${r.name}: ${r.err}`);
      failed += 1;
    }
  }
  console.log("");
  if (failed > 0) {
    console.log(`${failed} of ${results.length} failed`);
    process.exit(1);
  }
  console.log(`all ${results.length} pass`);
}

main().catch((err) => {
  console.error("audit harness threw:", err);
  process.exit(1);
});
