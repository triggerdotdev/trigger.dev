import { logger } from "~/services/logger.server";
import { getMollifierBuffer } from "./mollifierBuffer.server";
import { reportDrainingCount } from "./mollifierTelemetry.server";

// How often we ZCARD the draining-tracker set. Each poll is a single
// O(1) Redis call, so cadence is bounded by "how fresh do we want the
// gauge?" rather than cost. 15s gives a tight-enough window to spot a
// brief OOM-induced spike without burning RTTs, and lines up well with
// typical Prometheus scrape intervals.
const POLL_INTERVAL_MS = 15_000;

let intervalHandle: ReturnType<typeof setInterval> | null = null;

// Polls `mollifier:draining` cardinality on an interval and feeds the
// gauge in `mollifierTelemetry.server.ts`. Started from the drainer
// worker bootstrap (alongside `drainer.start()`) so it runs on the same
// pods that actually pop/ack entries — observability is colocated with
// the lifecycle.
//
// Idempotent: a second call is a no-op (Remix dev hot-reload re-runs
// the bootstrap; the existing interval keeps ticking).
export function startMollifierDrainingGauge(
  opts: {
    intervalMs?: number;
    getBuffer?: typeof getMollifierBuffer;
  } = {}
): void {
  if (intervalHandle !== null) return;

  const intervalMs = opts.intervalMs ?? POLL_INTERVAL_MS;
  const getBuffer = opts.getBuffer ?? getMollifierBuffer;

  // Fire one poll immediately so the gauge populates before the first
  // scrape rather than reading 0 for a full interval after boot.
  const tick = async () => {
    const buffer = getBuffer();
    if (!buffer) return;
    try {
      const count = await buffer.getDrainingCount();
      reportDrainingCount(count);
    } catch (err) {
      // Transient Redis blip — don't tank the loop, just leave the
      // gauge at its last-known value. A sustained Redis outage will
      // surface via the drainer's own alerts long before this gauge
      // staleness becomes a primary signal.
      logger.warn("Mollifier draining gauge poll failed; keeping previous value", { err });
    }
  };

  void tick();
  // unref so the interval doesn't keep the process alive past
  // graceful shutdown — the gauge is best-effort, not a flush boundary.
  intervalHandle = setInterval(() => {
    void tick();
  }, intervalMs);
  intervalHandle.unref?.();
}

// Test seam. Production code never calls this; lifecycle is implicitly
// process-end.
export function stopMollifierDrainingGauge(): void {
  if (intervalHandle === null) return;
  clearInterval(intervalHandle);
  intervalHandle = null;
}
