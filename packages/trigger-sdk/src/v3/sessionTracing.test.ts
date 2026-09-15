import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import {
  SemanticInternalAttributes as Attr,
  SessionChannelRouter,
  usage,
  WaitpointTimeoutError,
} from "@trigger.dev/core/v3";
import { TracingSDK, type TracingSDKConfig } from "@trigger.dev/core/v3/otel";
import { DevUsageManager } from "@trigger.dev/core/v3/workers";
import { afterAll, assert, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { traceSessionIdle, traceSessionWait } from "./sessionTracing.js";
import { tracer } from "./tracer.js";

type Exporter = NonNullable<TracingSDKConfig["exporters"]>[number];
type ExportedSpan = Parameters<Exporter["export"]>[0][number];
type WireSpan = {
  name: string;
  attributes: Array<{ key: string; value: { stringValue?: string; boolValue?: boolean } }>;
};

const spans: ExportedSpan[] = [];
const wireSpans: WireSpan[] = [];
// A real local OTLP receiver also captures partial spans, which external
// exporters intentionally omit. No tracer, router, or usage mocks are used.
const receiver = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (request.url === "/v1/traces") {
    const body = JSON.parse(Buffer.concat(chunks).toString());
    for (const resource of body.resourceSpans ?? []) {
      for (const scope of resource.scopeSpans ?? []) wireSpans.push(...scope.spans);
    }
  }
  response.writeHead(200, { "Content-Type": "application/json" }).end("{}");
});
let tracing: TracingSDK;

beforeAll(async () => {
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  const address = receiver.address();
  if (!address || typeof address === "string") throw new Error("Missing OTLP receiver address");
  tracing = new TracingSDK({
    url: `http://127.0.0.1:${address.port}`,
    forceFlushTimeoutMillis: 5_000,
    exporters: [
      {
        export(batch, done) {
          spans.push(...batch);
          done({ code: 0 });
        },
        async shutdown() {},
      },
    ],
  });
});

beforeEach(async () => {
  await tracing.flush();
  spans.length = 0;
  wireSpans.length = 0;
  usage.reset();
  usage.setGlobalUsageManager(new DevUsageManager());
});

afterAll(async () => {
  usage.reset();
  await tracing?.shutdown();
  await new Promise<void>((resolve, reject) =>
    receiver.close((error) => (error ? reject(error) : resolve()))
  );
});

function messageRouter() {
  return new SessionChannelRouter({
    kindOf: () => "message",
    routes: [{ name: "messages", delivery: "queue", replayable: true, kinds: ["message"] }],
  });
}

describe("session trace phases", () => {
  it.each([30, 10])(
    "shows a message arriving within a %ss idle window without a waitpoint",
    async (seconds) => {
      const router = messageRouter();
      const message = { id: "m1", seqNum: 1, data: { text: "hello" } };
      const measurement = usage.start();
      const result = await tracer.startActiveSpan("next message", async () => {
        const pending = traceSessionIdle("session_test", seconds, () =>
          router.next("messages", { timeoutMs: seconds * 1000 })
        );
        router.ingest(message);
        return pending;
      });
      const sample = usage.stop(measurement);

      expect(result).toBe(message);
      expect(sample.cpuTime).toBe(sample.wallTime);
      expect(spans.map((span) => span.name)).toEqual(["idle", "next message"]);
      const [idle, parent] = spans;
      assert(idle);
      assert(parent);
      expect(idle.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
      expect(idle.attributes["wait.idleTimeoutInSeconds"]).toBe(seconds);
      expect(idle.attributes[Attr.ENTITY_TYPE]).toBeUndefined();
      expect(idle.attributes.session).toBe("session_test");
    }
  );

  it("exports a linked waitpoint while waiting and keeps idle and durable usage separate", async () => {
    const router = messageRouter();
    let finish!: () => void;
    const completed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const measurement = usage.start();
    const result = { ok: true as const, waitpointId: "waitpoint_test" };
    const pending = tracer.startActiveSpan("next message", async () => {
      expect(
        await traceSessionIdle("session_test", 0.01, () =>
          router.next("messages", { timeoutMs: 10 })
        )
      ).toBeUndefined();
      return traceSessionWait("session_test", result.waitpointId, () =>
        usage.pauseAsync(async () => {
          expect(trace.getActiveSpan()).toBeDefined();
          entered();
          await completed;
          return result;
        })
      );
    });
    await waiting;
    try {
      const pausedUsage = measurement.sample().cpuTime;
      await tracing.flush();
      await sleep(10);
      // Usage rounds to milliseconds, so two samples can differ by 1ms.
      expect(Math.abs(measurement.sample().cpuTime - pausedUsage)).toBeLessThanOrEqual(1);
      const partial = wireSpans.find(
        (span) =>
          span.name === "wait.forToken()" &&
          span.attributes.some((attr) => attr.key === Attr.SPAN_PARTIAL && attr.value.boolValue)
      );
      expect(partial?.attributes).toEqual(
        expect.arrayContaining([
          { key: Attr.ENTITY_TYPE, value: { stringValue: "waitpoint" } },
          { key: Attr.ENTITY_ID, value: { stringValue: "waitpoint_test" } },
        ])
      );
    } finally {
      finish();
      await pending;
    }
    expect(await pending).toBe(result);
    const sample = usage.stop(measurement);
    expect(sample.wallTime - sample.cpuTime).toBeGreaterThanOrEqual(10);
    const idle = spans.find((span) => span.name === "idle")!;
    const wait = spans.find((span) => span.name === "wait.forToken()")!;
    const parent = spans.find((span) => span.name === "next message")!;
    expect(idle.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
    expect(wait.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
    expect(wait.attributes[Attr.ENTITY_ID]).toBe(result.waitpointId);
    expect(wait.status.code).toBe(SpanStatusCode.UNSET);
  });

  it("retains the waitpoint identity and timeout result on a failed wait", async () => {
    const result = { ok: false as const, error: new WaitpointTimeoutError("Timed out") };
    expect(await traceSessionWait("session_test", "waitpoint_timeout", async () => result)).toBe(
      result
    );
    expect(spans).toHaveLength(1);
    const span = spans[0];
    assert(span);
    expect(span.attributes[Attr.ENTITY_ID]).toBe("waitpoint_timeout");
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.events[0]?.attributes?.["exception.message"]).toBe("Timed out");
  });

  it.each(["idle", "wait"])(
    "ends the %s span and propagates an aborted operation",
    async (phase) => {
      const error = new Error("Operation aborted");
      const fail = async (): Promise<never> => {
        throw error;
      };
      const pending =
        phase === "idle"
          ? traceSessionIdle("session_test", 30, fail)
          : traceSessionWait("session_test", "waitpoint_aborted", fail);
      await expect(pending).rejects.toBe(error);
      expect(spans).toHaveLength(1);
      const span = spans[0];
      assert(span);
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.endTime[0]).toBeGreaterThan(0);
    }
  );
});
