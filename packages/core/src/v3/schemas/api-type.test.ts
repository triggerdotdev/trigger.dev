import { describe, it, expect } from "vitest";
import { InitializeDeploymentRequestBody, RunEvent, ListRunEventsResponse, ListRunEventsResponseWithStringDates } from "./api.js";
import type { InitializeDeploymentRequestBody as InitializeDeploymentRequestBodyType } from "./api.js";

describe("InitializeDeploymentRequestBody", () => {
  const base = { contentHash: "abc123" };

  describe("non-native build variant (isNativeBuild omitted or false)", () => {
    it("parses with only required fields", () => {
      const result = InitializeDeploymentRequestBody.safeParse(base);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.isNativeBuild).toBe(false);
      }
    });

    it("parses with isNativeBuild explicitly false", () => {
      const result = InitializeDeploymentRequestBody.safeParse({ ...base, isNativeBuild: false });
      expect(result.success).toBe(true);
    });

    it("parses with optional base fields", () => {
      const result = InitializeDeploymentRequestBody.safeParse({
        ...base,
        userId: "user_1",
        type: "MANAGED",
        runtime: "node",
        initialStatus: "PENDING",
      });
      expect(result.success).toBe(true);
    });

    it("strips native-only fields when isNativeBuild is false", () => {
      const result = InitializeDeploymentRequestBody.safeParse({
        ...base,
        isNativeBuild: false,
        skipPromotion: true,
      });
      // Zod discriminatedUnion matches the non-native branch and strips unknown keys
      expect(result.success).toBe(true);
      if (result.success) {
        expect("skipPromotion" in result.data).toBe(false);
      }
    });
  });

  describe("native build variant (isNativeBuild: true)", () => {
    it("parses with isNativeBuild true", () => {
      const result = InitializeDeploymentRequestBody.safeParse({
        ...base,
        isNativeBuild: true,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.isNativeBuild).toBe(true);
      }
    });

    it("parses with native-specific optional fields", () => {
      const result = InitializeDeploymentRequestBody.safeParse({
        ...base,
        isNativeBuild: true,
        skipPromotion: true,
        artifactKey: "artifact_abc",
        configFilePath: "trigger.config.ts",
        skipEnqueue: true,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.skipPromotion).toBe(true);
        expect(result.data.artifactKey).toBe("artifact_abc");
        expect(result.data.configFilePath).toBe("trigger.config.ts");
        expect(result.data.skipEnqueue).toBe(true);
      }
    });

    it("skipEnqueue defaults to false when omitted", () => {
      const result = InitializeDeploymentRequestBody.safeParse({
        ...base,
        isNativeBuild: true,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.skipEnqueue).toBe(false);
      }
    });
  });

  describe("rejects invalid inputs", () => {
    it("rejects missing contentHash", () => {
      const result = InitializeDeploymentRequestBody.safeParse({});
      expect(result.success).toBe(false);
    });

    it("rejects invalid type enum value", () => {
      const result = InitializeDeploymentRequestBody.safeParse({
        ...base,
        type: "INVALID",
      });
      expect(result.success).toBe(false);
    });

    it("rejects invalid initialStatus enum value", () => {
      const result = InitializeDeploymentRequestBody.safeParse({
        ...base,
        initialStatus: "RUNNING",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("type-level checks", () => {
    it("native variant exposes native-specific fields", () => {
      const result = InitializeDeploymentRequestBody.parse({
        ...base,
        isNativeBuild: true,
        skipPromotion: true,
      });

      if (result.isNativeBuild === true) {
        const _skipPromotion: boolean | undefined = result.skipPromotion;
        const _artifactKey: string | undefined = result.artifactKey;
        const _configFilePath: string | undefined = result.configFilePath;
        expect(_skipPromotion).toBe(true);
        expect(_artifactKey).toBeUndefined();
        expect(_configFilePath).toBeUndefined();
      }
    });

    it("non-native variant narrows correctly", () => {
      const result: InitializeDeploymentRequestBodyType =
        InitializeDeploymentRequestBody.parse(base);

      if (!result.isNativeBuild) {
        // Should only have base fields — native-specific fields should not exist
        const narrowed: { isNativeBuild?: false; contentHash: string } = result;
        expect(narrowed.contentHash).toBe("abc123");
      }
    });
  });
});

describe("RunEvent Schema", () => {
  const validEvent = {
    spanId: "span_123",
    parentId: "span_root",
    runId: "run_abc",
    message: "Test event",
    style: {
      icon: "task",
      variant: "primary",
    },
    startTime: "2024-03-14T00:00:00Z",
    duration: 1234,
    isError: false,
    isPartial: false,
    isCancelled: false,
    level: "INFO",
    kind: "TASK",
    attemptNumber: 1,
  };

  it("parses a valid event correctly", () => {
    const result = RunEvent.safeParse(validEvent);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.spanId).toBe("span_123");
      expect(result.data.startTime).toBeInstanceOf(Date);
      expect(result.data.level).toBe("INFO");
    }
  });

  it("fails on missing required fields", () => {
    const invalidEvent = { ...validEvent };
    delete (invalidEvent as any).spanId;
    const result = RunEvent.safeParse(invalidEvent);
    expect(result.success).toBe(false);
  });

  it("fails on invalid level", () => {
    const invalidEvent = { ...validEvent, level: "INVALID_LEVEL" };
    const result = RunEvent.safeParse(invalidEvent);
    expect(result.success).toBe(false);
  });

  it("coerces startTime to Date", () => {
    const result = RunEvent.parse(validEvent);
    expect(result.startTime).toBeInstanceOf(Date);
    expect(result.startTime.toISOString()).toBe("2024-03-14T00:00:00.000Z");
  });

  it("handles 19-digit nanosecond startTime strings", () => {
    const event = { ...validEvent, startTime: "1710374400000000000" };
    const result = RunEvent.parse(event);
    expect(result.startTime).toBeInstanceOf(Date);
    // 1710374400000000000 ns = 1710374400000 ms = 2024-03-14T00:00:00Z
    expect(result.startTime.toISOString()).toBe("2024-03-14T00:00:00.000Z");
  });

  it("should handle Date object", () => {
    const now = new Date();
    const result = RunEvent.safeParse({
      ...validEvent,
      startTime: now,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.startTime.toISOString()).toBe(now.toISOString());
    }
  });

  it("handles bigint nanosecond startTime", () => {
    const event = { ...validEvent, startTime: 1710374400000000000n };
    const result = RunEvent.parse(event as any);
    expect(result.startTime).toBeInstanceOf(Date);
    expect(result.startTime.toISOString()).toBe("2024-03-14T00:00:00.000Z");
  });

  it("fails on invalid startTime", () => {
    const event = { ...validEvent, startTime: "not-a-date" };
    const result = RunEvent.safeParse(event);
    expect(result.success).toBe(false);
  });

  describe("startTime edge cases", () => {
    it("should handle whitespace-padded strings", () => {
      const result = RunEvent.safeParse({
        ...validEvent,
        startTime: "  2024-03-14T00:00:00Z  ",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.startTime.toISOString()).toBe("2024-03-14T00:00:00.000Z");
      }
    });

    it("should handle whitespace-padded nanosecond strings", () => {
      const result = RunEvent.safeParse({
        ...validEvent,
        startTime: "  1710374400000000000  ",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.startTime.toISOString()).toBe("2024-03-14T00:00:00.000Z");
      }
    });

    it("should fail on empty string", () => {
      const result = RunEvent.safeParse({
        ...validEvent,
        startTime: "",
      });
      expect(result.success).toBe(false);
    });

    it("should fail on whitespace-only string", () => {
      const result = RunEvent.safeParse({
        ...validEvent,
        startTime: "   ",
      });
      expect(result.success).toBe(false);
    });
  });

  it("allows optional/null parentId", () => {
    const eventWithoutParent = { ...validEvent };
    delete (eventWithoutParent as any).parentId;
    expect(RunEvent.safeParse(eventWithoutParent).success).toBe(true);

    const eventWithNullParent = { ...validEvent, parentId: null };
    expect(RunEvent.safeParse(eventWithNullParent).success).toBe(true);
  });

  it("allows nullish attemptNumber", () => {
    const eventWithNullAttempt = { ...validEvent, attemptNumber: null };
    const result = RunEvent.safeParse(eventWithNullAttempt);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.attemptNumber).toBe(null);
    }

    const eventWithoutAttempt = { ...validEvent };
    delete (eventWithoutAttempt as any).attemptNumber;
    const result2 = RunEvent.safeParse(eventWithoutAttempt);
    expect(result2.success).toBe(true);
  });

  it("supports taskSlug", () => {
    const eventWithSlug = { ...validEvent, taskSlug: "my-task" };
    const result = RunEvent.parse(eventWithSlug);
    expect(result.taskSlug).toBe("my-task");
  });

  it("ListRunEventsResponseWithStringDates correctly transforms Dates to strings", () => {
    const rawResponse = {
      events: [validEvent],
    };

    const parsed = ListRunEventsResponse.parse(rawResponse);
    expect(parsed.events[0]!.startTime).toBeInstanceOf(Date);

    const legacy = ListRunEventsResponseWithStringDates.parse(rawResponse);
    expect(typeof legacy.events[0]!.startTime).toBe("string");
    expect(legacy.events[0]!.startTime).toBe(parsed.events[0]!.startTime.toISOString());
  });
});

describe("ListRunEventsResponse Schema", () => {
  it("parses a valid wrapped response", () => {
    const response = {
      events: [
        {
          spanId: "span_1",
          runId: "run_1",
          message: "Event 1",
          style: {},
          startTime: "2024-03-14T00:00:00Z",
          duration: 100,
          isError: false,
          isPartial: false,
          isCancelled: false,
          level: "INFO",
          kind: "TASK",
        },
      ],
    };

    const result = ListRunEventsResponse.safeParse(response);
    expect(result.success).toBe(true);
    if (result.success && result.data) {
      expect(result.data.events[0]!.spanId).toBe("span_1");
    }
  });

  it("fails on plain array", () => {
    const response = [{ spanId: "span_1" }];
    const result = ListRunEventsResponse.safeParse(response);
    expect(result.success).toBe(false);
  });
});
