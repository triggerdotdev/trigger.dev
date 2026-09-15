// Real worker that always reports a failed task, to exercise the pool's error-outcome metric.
const { parentPort } = require("node:worker_threads");

parentPort.on("message", (message) => {
  if (message && message.type === "pricing") return;
  parentPort.postMessage({ id: message.id, ok: false, error: "boom" });
});
