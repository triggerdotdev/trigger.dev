import { type MeterProvider } from "@opentelemetry/sdk-metrics";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";

export function startNodejsRuntimeMetrics(meterProvider: MeterProvider) {
  const meter = meterProvider.getMeter("nodejs-runtime", "1.0.0");

  // Event loop utilization (diff between collection intervals)
  let lastElu = performance.eventLoopUtilization();

  const eluGauge = meter.createObservableGauge("nodejs.event_loop.utilization", {
    description: "Event loop utilization over the last collection interval",
    unit: "1",
  });

  // Event loop delay histogram (from perf_hooks)
  const eld = monitorEventLoopDelay({ resolution: 20 });
  eld.enable();

  const eldP95 = meter.createObservableGauge("nodejs.event_loop.delay.p95", {
    description: "p95 event loop delay",
    unit: "s",
  });
  const eldMax = meter.createObservableGauge("nodejs.event_loop.delay.max", {
    description: "Max event loop delay",
    unit: "s",
  });

  // Heap metrics
  const heapUsed = meter.createObservableGauge("nodejs.heap.used", {
    description: "V8 heap used",
    unit: "By",
  });
  const heapTotal = meter.createObservableGauge("nodejs.heap.total", {
    description: "V8 heap total allocated",
    unit: "By",
  });

  // Single batch callback for all metrics
  meter.addBatchObservableCallback(
    (obs) => {
      // ELU
      const currentElu = performance.eventLoopUtilization();
      const diff = performance.eventLoopUtilization(currentElu, lastElu);
      lastElu = currentElu;
      obs.observe(eluGauge, diff.utilization);

      // Event loop delay (nanoseconds -> seconds)
      obs.observe(eldP95, eld.percentile(95) / 1e9);
      obs.observe(eldMax, eld.max / 1e9);
      eld.reset();

      // Heap
      const mem = process.memoryUsage();
      obs.observe(heapUsed, mem.heapUsed);
      obs.observe(heapTotal, mem.heapTotal);
    },
    [eluGauge, eldP95, eldMax, heapUsed, heapTotal]
  );
}
