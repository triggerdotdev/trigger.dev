import type { ExportResult } from "@opentelemetry/core";
import type { PushMetricExporter, ResourceMetrics } from "@opentelemetry/sdk-metrics";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SemanticInternalAttributes } from "../semanticInternalAttributes.js";
import { taskContext } from "../task-context-api.js";
import { unregisterGlobal } from "../utils/globals.js";
import { TaskContextMetricExporter } from "./otelProcessors.js";

const FAKE_CTX = {
  attempt: { id: "attempt_1", number: 1, startedAt: new Date(), status: "EXECUTING" as const },
  run: {
    id: "run_1",
    payload: undefined,
    payloadType: "application/json",
    context: undefined,
    createdAt: new Date(),
    tags: ["agent", "waitpoint"],
    isTest: false,
    isReplay: false,
    startedAt: new Date(),
    durationMs: 0,
    costInCents: 0,
    baseCostInCents: 0,
  },
  task: { id: "agent-workflow", filePath: "src/trigger/agent.ts", exportName: "agentWorkflow" },
  queue: { id: "queue_1", name: "default" },
  environment: { id: "env_1", slug: "dev", type: "DEVELOPMENT" as const },
  organization: { id: "org_1", slug: "acme", name: "Acme" },
  project: { id: "proj_1", ref: "proj_xyz", slug: "demo", name: "Demo" },
  machine: {
    name: "small-1x" as const,
    cpu: 0.5,
    memory: 0.5,
    centsPerMs: 0.0001,
  },
} as never;

const FAKE_WORKER = { id: "worker_1", version: "1.0.0", contentHash: "abc" } as never;

class CapturingMetricExporter implements PushMetricExporter {
  public exports: ResourceMetrics[] = [];

  export(metrics: ResourceMetrics, resultCallback: (result: ExportResult) => void): void {
    this.exports.push(metrics);
    resultCallback({ code: 0 });
  }

  async forceFlush(): Promise<void> {}

  async shutdown(): Promise<void> {}
}

function createMetrics(): ResourceMetrics {
  return {
    resource: {} as ResourceMetrics["resource"],
    scopeMetrics: [
      {
        metrics: [
          {
            dataPoints: [
              {
                attributes: { existing: "value" },
              },
            ],
          },
        ],
        scope: { name: "test-scope" },
      },
    ],
  } as unknown as ResourceMetrics;
}

function firstDataPointAttributes(metrics: ResourceMetrics) {
  return metrics.scopeMetrics[0]!.metrics[0]!.dataPoints[0]!.attributes;
}

describe("TaskContextMetricExporter run attribution", () => {
  afterEach(() => {
    unregisterGlobal("task-context");
    taskContext.setConversationId(undefined);
  });

  it("strips run-specific attributes while run context is disabled between active execution", () => {
    taskContext.setGlobalTaskContext({ ctx: FAKE_CTX, worker: FAKE_WORKER });
    taskContext.disable();

    const innerExporter = new CapturingMetricExporter();
    const exporter = new TaskContextMetricExporter(innerExporter);

    exporter.export(createMetrics(), vi.fn());

    const attrs = firstDataPointAttributes(innerExporter.exports[0]!);
    expect(attrs[SemanticInternalAttributes.RUN_ID]).toBeUndefined();
    expect(attrs[SemanticInternalAttributes.TASK_SLUG]).toBeUndefined();
    expect(attrs[SemanticInternalAttributes.ATTEMPT_NUMBER]).toBeUndefined();
    expect(attrs[SemanticInternalAttributes.ENVIRONMENT_ID]).toBe("env_1");
    expect(attrs[SemanticInternalAttributes.PROJECT_ID]).toBe("proj_1");
  });

  it("restores run attribution after waitpoint resume re-enables task context", () => {
    taskContext.setGlobalTaskContext({ ctx: FAKE_CTX, worker: FAKE_WORKER });
    taskContext.disable();
    taskContext.enable();

    const innerExporter = new CapturingMetricExporter();
    const exporter = new TaskContextMetricExporter(innerExporter);

    exporter.export(createMetrics(), vi.fn());

    const attrs = firstDataPointAttributes(innerExporter.exports[0]!);
    expect(attrs[SemanticInternalAttributes.RUN_ID]).toBe("run_1");
    expect(attrs[SemanticInternalAttributes.TASK_SLUG]).toBe("agent-workflow");
    expect(attrs[SemanticInternalAttributes.ATTEMPT_NUMBER]).toBe(1);
    expect(attrs[SemanticInternalAttributes.RUN_TAGS]).toEqual(["agent", "waitpoint"]);
    expect(attrs[SemanticInternalAttributes.WORKER_ID]).toBe("worker_1");
  });
});
