import { parentPort, workerData } from "node:worker_threads";
import { ModelPricingRegistry } from "@internal/llm-model-catalog";
import type { LlmModelWithPricing } from "@internal/llm-model-catalog";
import {
  ExportLogsServiceRequest,
  ExportMetricsServiceRequest,
  ExportTraceServiceRequest,
} from "@trigger.dev/otlp-importer";
import {
  convertLogsToCreateableEvents,
  convertMetricsToClickhouseRows,
  convertSpansToCreateableEvents,
  filterResourceLogs,
  filterResourceMetrics,
  filterResourceSpans,
} from "./otlpTransform.server";
import { enrichCreatableEvents, setLlmPricingRegistry } from "./utils/enrichCreatableEvents.server";

type TransformTask = {
  id: number;
  kind: "traces" | "logs" | "metrics";
  payload: Uint8Array;
  spanAttributeValueLengthLimit: number;
  defaultEventStore: string;
};

type PricingUpdate = { type: "pricing"; models: LlmModelWithPricing[] };

// The main thread is the only DB reader; it broadcasts the compiled model rows here.
const registry = new ModelPricingRegistry();
setLlmPricingRegistry(registry);

function applyPricing(models: LlmModelWithPricing[]) {
  registry.loadFromModels(models);
}

if (Array.isArray(workerData?.pricingModels)) {
  applyPricing(workerData.pricingModels);
}

function runTask(task: TransformTask) {
  const bytes = new Uint8Array(task.payload);

  if (task.kind === "traces") {
    const request = ExportTraceServiceRequest.decode(bytes);
    const eventsWithStores = filterResourceSpans(request.resourceSpans).flatMap((resourceSpan) =>
      convertSpansToCreateableEvents(
        resourceSpan,
        task.spanAttributeValueLengthLimit,
        task.defaultEventStore
      )
    );
    for (const group of eventsWithStores) {
      group.events = enrichCreatableEvents(group.events);
    }
    return { eventsWithStores };
  }

  if (task.kind === "logs") {
    const request = ExportLogsServiceRequest.decode(bytes);
    const eventsWithStores = filterResourceLogs(request.resourceLogs).flatMap((resourceLog) =>
      convertLogsToCreateableEvents(
        resourceLog,
        task.spanAttributeValueLengthLimit,
        task.defaultEventStore
      )
    );
    for (const group of eventsWithStores) {
      group.events = enrichCreatableEvents(group.events);
    }
    return { eventsWithStores };
  }

  const request = ExportMetricsServiceRequest.decode(bytes);
  const rows = filterResourceMetrics(request.resourceMetrics).flatMap((resourceMetrics) =>
    convertMetricsToClickhouseRows(resourceMetrics, task.spanAttributeValueLengthLimit)
  );
  return { rows };
}

if (!parentPort) {
  throw new Error("otlpTransformWorker must be run as a worker thread");
}

parentPort.on("message", (message: TransformTask | PricingUpdate) => {
  if ("type" in message && message.type === "pricing") {
    applyPricing(message.models);
    return;
  }

  const task = message as TransformTask;
  try {
    // The worker has no MeterProvider, so it can't emit metrics itself. It measures its own
    // compute time (decode + convert + enrich) and hands it back for the main thread to record.
    const startedAt = performance.now();
    const result = runTask(task);
    const computeMs = performance.now() - startedAt;
    parentPort!.postMessage({ id: task.id, ok: true, result, computeMs });
  } catch (error) {
    parentPort!.postMessage({
      id: task.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
