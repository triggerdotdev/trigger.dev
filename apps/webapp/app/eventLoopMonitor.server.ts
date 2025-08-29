import { createHook } from "node:async_hooks";
import { singleton } from "./utils/singleton";
import { tracer } from "./v3/tracer.server";
import { env } from "./env.server";
import { context, Context } from "@opentelemetry/api";

const THRESHOLD_NS = env.EVENT_LOOP_MONITOR_THRESHOLD_MS * 1e6;

const cache = new Map<number, { type: string; start?: [number, number]; parentCtx?: Context }>();

function init(asyncId: number, type: string, triggerAsyncId: number, resource: any) {
  cache.set(asyncId, {
    type,
  });
}

function destroy(asyncId: number) {
  cache.delete(asyncId);
}

function before(asyncId: number) {
  const cached = cache.get(asyncId);

  if (!cached) {
    return;
  }

  cache.set(asyncId, {
    ...cached,
    start: process.hrtime(),
    parentCtx: context.active(),
  });
}

function after(asyncId: number) {
  const cached = cache.get(asyncId);

  if (!cached) {
    return;
  }

  cache.delete(asyncId);

  if (!cached.start) {
    return;
  }

  const diff = process.hrtime(cached.start);
  const diffNs = diff[0] * 1e9 + diff[1];
  if (diffNs > THRESHOLD_NS) {
    const time = diffNs / 1e6; // in ms

    const newSpan = tracer.startSpan(
      "event-loop-blocked",
      {
        startTime: new Date(new Date().getTime() - time),
        attributes: {
          asyncType: cached.type,
          label: "EventLoopMonitor",
        },
      },
      cached.parentCtx
    );

    newSpan.end();
  }
}

export const eventLoopMonitor = singleton("eventLoopMonitor", () => {
  const hook = createHook({ init, before, after, destroy });

  return {
    enable: () => {
      console.log("🥸  Initializing event loop monitor");

      hook.enable();
    },
    disable: () => {
      console.log("🥸  Disabling event loop monitor");

      hook.disable();
    },
  };
});
