import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it } from "vitest";
import { SemanticInternalAttributes } from "../semanticInternalAttributes.js";
import { taskContext } from "../task-context-api.js";
import { TaskContextSpanProcessor } from "../taskContext/otelProcessors.js";
import { unregisterGlobal } from "../utils/globals.js";
import { UserSpanProcessorWrapper } from "./userSpanProcessor.js";

function processor(handlers: Partial<SpanProcessor>): SpanProcessor {
  return {
    onStart: () => {},
    onEnd: () => {},
    forceFlush: async () => {},
    shutdown: async () => {},
    ...handlers,
  };
}

const redactOnEnd = processor({
  onEnd: (span) => {
    for (const key of Object.keys(span.attributes)) {
      span.attributes[key] = "[redacted]";
    }
  },
});

const FAKE_CTX = {
  attempt: { id: "attempt_1", number: 1, startedAt: new Date(), status: "EXECUTING" as const },
  run: {
    id: "run_1",
    payload: undefined,
    payloadType: "application/json",
    context: undefined,
    createdAt: new Date(),
    tags: ["customer:someone@example.com"],
    idempotencyKey: "someone@example.com",
    isTest: false,
    isReplay: false,
    startedAt: new Date(),
    durationMs: 0,
    costInCents: 0,
    baseCostInCents: 0,
  },
  task: { id: "my-task", filePath: "src/trigger/task.ts", exportName: "myTask" },
  queue: { id: "queue_1", name: "default" },
  environment: { id: "env_1", slug: "dev", type: "DEVELOPMENT" as const },
  organization: { id: "org_1", slug: "acme", name: "Acme" },
  project: { id: "proj_1", ref: "proj_xyz", slug: "demo", name: "Demo" },
  machine: { name: "small-1x" as const, cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 },
} as never;

const FAKE_WORKER = { id: "worker_1", version: "1.0.0", contentHash: "abc" } as never;

const metadataKey = (key: string) => `${SemanticInternalAttributes.METADATA}.${key}`;

function setup(userProcessor: SpanProcessor) {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [
      new UserSpanProcessorWrapper(userProcessor),
      new TaskContextSpanProcessor("test", new SimpleSpanProcessor(exporter)),
    ],
  });
  trace.setGlobalTracerProvider(provider);

  return { exporter, tracer: provider.getTracer("test") };
}

function partialOf(spans: ReadableSpan[]) {
  return spans.find((s) => s.attributes[SemanticInternalAttributes.SPAN_PARTIAL] === true);
}

function finalOf(spans: ReadableSpan[]) {
  return spans.find((s) => s.attributes[SemanticInternalAttributes.SPAN_PARTIAL] !== true);
}

describe("UserSpanProcessorWrapper", () => {
  afterEach(() => {
    trace.disable();
    unregisterGlobal("task-context");
  });

  it("keeps run linking from the task context while a blanket scrubber redacts the rest", () => {
    taskContext.setGlobalTaskContext({ ctx: FAKE_CTX, worker: FAKE_WORKER });
    const { exporter, tracer } = setup(
      processor({
        onEnding: (span) => {
          for (const key of Object.keys(span.attributes)) {
            span.attributes[key] = "[redacted]";
          }
        },
      })
    );

    tracer.startSpan("chat turn 1", { attributes: { "chat.user_message": "hi" } }).end();

    const spans = exporter.getFinishedSpans();
    for (const span of [partialOf(spans), finalOf(spans)]) {
      expect(span?.attributes[metadataKey(SemanticInternalAttributes.RUN_ID)]).toBe("run_1");
      expect(span?.attributes[metadataKey(SemanticInternalAttributes.TASK_SLUG)]).toBe("my-task");
      expect(span?.attributes[metadataKey(SemanticInternalAttributes.ATTEMPT_NUMBER)]).toBe(1);
      expect(span?.attributes[metadataKey(SemanticInternalAttributes.IDEMPOTENCY_KEY)]).toBe(
        "[redacted]"
      );
      expect(span?.attributes[SemanticInternalAttributes.RUN_TAGS]).toBe("[redacted]");
      expect(span?.attributes["chat.user_message"]).toBe("[redacted]");
    }
  });

  it("forwards onEnding, where setAttribute still works", () => {
    const { exporter, tracer } = setup(
      processor({
        onEnding: (span) => {
          span.setAttribute("chat.user_message", "[redacted]");
        },
      })
    );

    tracer.startSpan("chat turn 1", { attributes: { "chat.user_message": "hi" } }).end();

    const spans = exporter.getFinishedSpans();
    expect(partialOf(spans)?.attributes["chat.user_message"]).toBe("[redacted]");
    expect(finalOf(spans)?.attributes["chat.user_message"]).toBe("[redacted]");
  });

  it("redacts attributes on both the partial and the final span before export", () => {
    const { exporter, tracer } = setup(redactOnEnd);

    const span = tracer.startSpan("chat turn 1", {
      attributes: { "chat.user_message": "my email is someone@example.com" },
    });
    span.setAttribute("chat.client_data", '{"userId":"123"}');
    span.end();

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(2);
    expect(partialOf(spans)?.attributes["chat.user_message"]).toBe("[redacted]");
    expect(finalOf(spans)?.attributes["chat.user_message"]).toBe("[redacted]");
    expect(finalOf(spans)?.attributes["chat.client_data"]).toBe("[redacted]");
  });

  it("restores the attributes the dashboard needs to link spans", () => {
    const { exporter, tracer } = setup(redactOnEnd);

    const span = tracer.startSpan("chat turn 1", {
      attributes: {
        [SemanticInternalAttributes.RUN_ID]: "run_123",
        [SemanticInternalAttributes.ENTITY_TYPE]: "chat-turn",
        [SemanticInternalAttributes.STYLE_ICON]: "tabler-message-chatbot",
        [`${SemanticInternalAttributes.STYLE_ACCESSORY}.items.0.text`]: "my email is someone",
      },
    });
    span.end();

    const spans = exporter.getFinishedSpans();
    const partial = partialOf(spans);
    const final = finalOf(spans);

    expect(partial).toBeDefined();
    expect(partial?.attributes[SemanticInternalAttributes.SPAN_ID]).toBe(
      final?.spanContext().spanId
    );
    expect(final?.attributes[SemanticInternalAttributes.RUN_ID]).toBe("run_123");
    expect(final?.attributes[SemanticInternalAttributes.ENTITY_TYPE]).toBe("chat-turn");
    expect(final?.attributes[SemanticInternalAttributes.STYLE_ICON]).toBe("tabler-message-chatbot");
    expect(final?.attributes[`${SemanticInternalAttributes.STYLE_ACCESSORY}.items.0.text`]).toBe(
      "[redacted]"
    );
  });

  it("keeps exporting when the user processor throws", () => {
    const { exporter, tracer } = setup(
      processor({
        onStart: () => {
          throw new Error("onStart failed");
        },
        onEnd: () => {
          throw new Error("onEnd failed");
        },
      })
    );

    expect(() => {
      const span = tracer.startSpan("chat turn 1", { attributes: { "chat.trigger": "submit" } });
      span.end();
    }).not.toThrow();

    expect(finalOf(exporter.getFinishedSpans())?.attributes["chat.trigger"]).toBe("submit");
  });
});
