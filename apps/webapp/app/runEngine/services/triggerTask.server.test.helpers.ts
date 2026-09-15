// Shared harness for the triggerTask.server.*.test.ts family. The suite is split
// across per-concern files (parentReads / lockedWorker / combinedReads) so CI's
// duration-based sharding can spread the container-heavy tests over shards; these
// helpers hold the pure mocks and engine wiring they all share.
//
// NOTE: this is not a test file (vitest's include only matches *.test.ts) and it
// must not import from "vitest" — vi.mock declarations live in each test file
// because vitest hoists them per test module.
import { RunEngine } from "@internal/run-engine";
import { trace } from "@opentelemetry/api";
import type { IOPacket } from "@trigger.dev/core/v3";
import type { TaskRun } from "@trigger.dev/database";
import type {
  EntitlementValidationParams,
  MaxAttemptsValidationParams,
  ParentRunValidationParams,
  PayloadProcessor,
  TagValidationParams,
  TracedEventSpan,
  TraceEventConcern,
  TriggerTaskRequest,
  TriggerTaskValidator,
  ValidationResult,
} from "~/runEngine/types";

export class MockPayloadProcessor implements PayloadProcessor {
  async process(request: TriggerTaskRequest): Promise<IOPacket> {
    return {
      data: JSON.stringify(request.body.payload),
      dataType: "application/json",
    };
  }
}

// Captures the `parentRun` the service resolved (via runStore.findRun) and
// passed into validation, so a test can assert on the resolved parent without
// mocking the read itself. Returns ok so the child triggers regardless.
export class CapturingParentRunValidator implements TriggerTaskValidator {
  public capturedParentRun: ParentRunValidationParams["parentRun"] | "unset" = "unset";

  validateTags(_params: TagValidationParams): ValidationResult {
    return { ok: true };
  }
  validateEntitlement(_params: EntitlementValidationParams): Promise<ValidationResult> {
    return Promise.resolve({ ok: true });
  }
  validateMaxAttempts(_params: MaxAttemptsValidationParams): ValidationResult {
    return { ok: true };
  }
  validateParentRun(params: ParentRunValidationParams): ValidationResult {
    this.capturedParentRun = params.parentRun;
    return { ok: true };
  }
}

export class MockTraceEventConcern implements TraceEventConcern {
  async traceRun<T>(
    _request: TriggerTaskRequest,
    _parentStore: string | undefined,
    callback: (span: TracedEventSpan, store: string) => Promise<T>
  ): Promise<T> {
    return await callback(
      {
        traceId: "test",
        spanId: "test",
        traceContext: {},
        traceparent: undefined,
        setAttribute: () => {},
        failWithError: () => {},
        stop: () => {},
      },
      "test"
    );
  }

  async traceIdempotentRun<T>(
    _request: TriggerTaskRequest,
    _parentStore: string | undefined,
    _options: {
      existingRun: TaskRun;
      idempotencyKey: string;
      incomplete: boolean;
      isError: boolean;
    },
    callback: (span: TracedEventSpan, store: string) => Promise<T>
  ): Promise<T> {
    return await callback(
      {
        traceId: "test",
        spanId: "test",
        traceContext: {},
        traceparent: undefined,
        setAttribute: () => {},
        failWithError: () => {},
        stop: () => {},
      },
      "test"
    );
  }

  async traceDebouncedRun<T>(
    _request: TriggerTaskRequest,
    _parentStore: string | undefined,
    _options: {
      existingRun: TaskRun;
      debounceKey: string;
      incomplete: boolean;
      isError: boolean;
    },
    callback: (span: TracedEventSpan, store: string) => Promise<T>
  ): Promise<T> {
    return await callback(
      {
        traceId: "test",
        spanId: "test",
        traceContext: {},
        traceparent: undefined,
        setAttribute: () => {},
        failWithError: () => {},
        stop: () => {},
      },
      "test"
    );
  }
}

export function buildEngine(prisma: any, redisOptions: any) {
  return new RunEngine({
    prisma,
    worker: {
      redis: redisOptions,
      workers: 1,
      tasksPerWorker: 10,
      pollIntervalMs: 100,
    },
    queue: {
      redis: redisOptions,
    },
    runLock: {
      redis: redisOptions,
    },
    machines: {
      defaultMachine: "small-1x",
      machines: {
        "small-1x": {
          name: "small-1x" as const,
          cpu: 0.5,
          memory: 0.5,
          centsPerMs: 0.0001,
        },
      },
      baseCostInCents: 0.0005,
    },
    tracer: trace.getTracer("test", "0.0.0"),
  });
}
