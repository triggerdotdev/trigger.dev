/**
 * Real worker that takes a fixed wall-clock time per task, so pool tests can drive queue wait past
 * the task deadline while the worker itself stays healthy. Delay comes from
 * OTLP_SLOW_WORKER_DELAY_MS (default 100). When OTLP_SLOW_WORKER_HANG_AFTER is set the worker
 * answers that many tasks and then never replies again, to model a worker that wedges mid-run.
 */
const { parentPort } = require("node:worker_threads");

const delayMs = Number(process.env.OTLP_SLOW_WORKER_DELAY_MS ?? 100);
const hangAfter = process.env.OTLP_SLOW_WORKER_HANG_AFTER
  ? Number(process.env.OTLP_SLOW_WORKER_HANG_AFTER)
  : Infinity;
let answered = 0;

parentPort.on("message", (message) => {
  if (message && message.type === "pricing") return;
  if (answered >= hangAfter) return;
  answered++;
  setTimeout(() => {
    parentPort.postMessage({ id: message.id, ok: true, result: { rows: [] }, computeMs: delayMs });
  }, delayMs);
});
