// Minimal real worker for OtlpWorkerPool metric tests: echoes an ok result with a compute time.
const { parentPort } = require("node:worker_threads");

parentPort.on("message", (message) => {
  if (message && message.type === "pricing") return;
  parentPort.postMessage({ id: message.id, ok: true, result: { rows: [] }, computeMs: 2 });
});
