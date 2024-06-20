import { createHook } from "node:async_hooks";
import { logger } from "./services/logger.server";
import { singleton } from "./utils/singleton";

const THRESHOLD_NS = 1e8; // 100ms

const cache = new Map<number, [number, number]>();

function before(asyncId: number) {
  cache.set(asyncId, process.hrtime());
}

function after(asyncId: number) {
  const cached = cache.get(asyncId);
  if (cached == null) {
    return;
  }
  cache.delete(asyncId);

  const diff = process.hrtime(cached);
  const diffNs = diff[0] * 1e9 + diff[1];
  if (diffNs > THRESHOLD_NS) {
    const time = diffNs / 1e6; // in ms

    logger.error(`Event loop was blocked for ${time}ms`, {
      label: "EventLoopMonitor",
      startTime: new Date(new Date().getTime() - time),
      durationMs: time,
    });
  }
}

export const eventLoopMonitor = singleton("eventLoopMonitor", () => {
  // console.log("🥸 Initializing event loop monitor");
  // const asyncHook = createHook({ before, after });
  // asyncHook.enable();
  // return asyncHook;
});
