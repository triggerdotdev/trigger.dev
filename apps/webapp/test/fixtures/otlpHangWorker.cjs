/**
 * Real worker that never replies, to exercise the pool's stuck-worker reap path.
 */
const { parentPort } = require("node:worker_threads");

parentPort.on("message", () => {});
