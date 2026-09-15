// Shared mock implementations for the triggerTask engine test suite. These are
// extracted so the suite can be split across several *.test.ts files (vitest
// shards by whole file) without duplicating the mocks. No `vi.mock` lives here:
// module mocks are hoisted per-file and must stay in each test file.
import { promiseWithResolvers } from "@trigger.dev/core";
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
  TriggerRacepoints,
  TriggerRacepointSystem,
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

export class MockTriggerTaskValidator implements TriggerTaskValidator {
  validateTags(params: TagValidationParams): ValidationResult {
    return { ok: true };
  }
  validateEntitlement(params: EntitlementValidationParams): Promise<ValidationResult> {
    return Promise.resolve({ ok: true });
  }
  validateMaxAttempts(params: MaxAttemptsValidationParams): ValidationResult {
    return { ok: true };
  }
  validateParentRun(params: ParentRunValidationParams): ValidationResult {
    return { ok: true };
  }
}

// Mirror the production ClickhouseEventRepository.traceEvent shape so
// callers that read `event.traceContext.traceparent` (e.g. the
// mollifier branch seeding the snapshot) get the same W3C-formatted
// value they'd get against a real event repository.
export const MOCK_TRACE_ID = "0123456789abcdef0123456789abcdef";
export const MOCK_SPAN_ID = "fedcba9876543210";
const MOCK_TRACEPARENT = `00-${MOCK_TRACE_ID}-${MOCK_SPAN_ID}-01`;

export class MockTraceEventConcern implements TraceEventConcern {
  // Records the start time of the most recent traceRun callback entry.
  // Used by ordering assertions that verify traceRun fires before
  // downstream side effects (e.g. mollifier buffer writes).
  public traceRunEnteredAt: number | undefined;

  async traceRun<T>(
    request: TriggerTaskRequest,
    parentStore: string | undefined,
    callback: (span: TracedEventSpan, store: string) => Promise<T>
  ): Promise<T> {
    this.traceRunEnteredAt = Date.now();
    return await callback(
      {
        traceId: MOCK_TRACE_ID,
        spanId: MOCK_SPAN_ID,
        traceContext: { traceparent: MOCK_TRACEPARENT },
        traceparent: undefined,
        setAttribute: () => {},
        failWithError: () => {},
        stop: () => {},
      },
      "test"
    );
  }

  async traceIdempotentRun<T>(
    request: TriggerTaskRequest,
    parentStore: string | undefined,
    options: {
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
    request: TriggerTaskRequest,
    parentStore: string | undefined,
    options: {
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

type TriggerRacepoint = { promise: Promise<void>; resolve: (value: void) => void };

export class MockTriggerRacepointSystem implements TriggerRacepointSystem {
  private racepoints: Record<string, TriggerRacepoint | undefined> = {};

  async waitForRacepoint({ id }: { racepoint: TriggerRacepoints; id: string }): Promise<void> {
    const racepoint = this.racepoints[id];

    if (racepoint) {
      return racepoint.promise;
    }

    return Promise.resolve();
  }

  registerRacepoint(racepoint: TriggerRacepoints, id: string): TriggerRacepoint {
    const { promise, resolve } = promiseWithResolvers<void>();
    this.racepoints[id] = { promise, resolve };

    return { promise, resolve };
  }
}
