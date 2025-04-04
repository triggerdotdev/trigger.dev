import { describe, test, expect } from "vitest";
import { SpanEvent } from "@trigger.dev/core/v3";
import { createTimelineSpanEventsFromSpanEvents } from "../app/utils/timelineSpanEvents";
import { millisecondsToNanoseconds } from "@trigger.dev/core/v3/utils/durations";

describe("createTimelineSpanEventsFromSpanEvents", () => {
  const sampleSpanEvents: SpanEvent[] = [
    {
      name: "trigger.dev/start",
      time: new Date("2025-04-04T08:39:27.046Z"),
      properties: { event: "fork", duration: 127 },
    },
    {
      name: "trigger.dev/start",
      time: new Date("2025-04-04T08:39:26.985Z"),
      properties: { event: "create_attempt", duration: 56 },
    },
    {
      name: "trigger.dev/start",
      time: new Date("2025-04-04T08:39:26.980Z"),
      properties: { event: "dequeue", duration: 0 },
    },
    {
      name: "trigger.dev/start",
      time: new Date("2025-04-04T08:39:27.224Z"),
      properties: {
        file: "src/trigger/chat.ts",
        event: "import",
        duration: 67,
        entryPoint:
          "/Users/eric/code/triggerdotdev/trigger.dev/references/d3-chat/.trigger/tmp/build-AL7zTl/references/d3-chat/src/trigger/chat.mjs",
      },
    },
  ];

  // Sample events without fork event
  const eventsWithoutFork: SpanEvent[] = [
    {
      name: "trigger.dev/start",
      time: new Date("2025-04-04T08:39:26.980Z"),
      properties: { event: "dequeue", duration: 0 },
    },
    {
      name: "trigger.dev/start",
      time: new Date("2025-04-04T08:39:26.985Z"),
      properties: { event: "create_attempt", duration: 56 },
    },
    {
      name: "trigger.dev/start",
      time: new Date("2025-04-04T08:39:27.224Z"),
      properties: {
        file: "src/trigger/chat.ts",
        event: "import",
        duration: 67,
        entryPoint:
          "/Users/eric/code/triggerdotdev/trigger.dev/references/d3-chat/.trigger/tmp/build-AL7zTl/references/d3-chat/src/trigger/chat.mjs",
      },
    },
  ];

  test("should filter non-admin events when isAdmin is false", () => {
    const result = createTimelineSpanEventsFromSpanEvents(sampleSpanEvents, false);

    // Only dequeue and fork events should be visible for non-admins
    expect(result.length).toBe(2);
    expect(result.some((event) => event.name === "Dequeued")).toBe(true);
    expect(result.some((event) => event.name === "Launched")).toBe(true);
    expect(result.some((event) => event.name === "Attempt created")).toBe(false);
    expect(result.some((event) => event.name.includes("Importing"))).toBe(false);
  });

  test("should include all events when isAdmin is true", () => {
    const result = createTimelineSpanEventsFromSpanEvents(sampleSpanEvents, true);

    expect(result.length).toBe(4);
    expect(result.some((event) => event.name === "Dequeued")).toBe(true);
    expect(result.some((event) => event.name === "Launched")).toBe(true);
    expect(result.some((event) => event.name === "Attempt created")).toBe(true);
    expect(result.some((event) => event.name === "Importing src/trigger/chat.ts")).toBe(true);
  });

  test("should sort events by timestamp", () => {
    const result = createTimelineSpanEventsFromSpanEvents(sampleSpanEvents, true);

    // Events should be sorted by time (offset)
    expect(result[0].name).toBe("Dequeued");
    expect(result[1].name).toBe("Attempt created");
    expect(result[2].name).toBe("Launched");
    expect(result[3].name).toBe("Importing src/trigger/chat.ts");
  });

  test("should calculate offsets correctly from the first event", () => {
    const result = createTimelineSpanEventsFromSpanEvents(sampleSpanEvents, true);

    // First event (dequeue) should have offset 0
    const firstEventTime = new Date("2025-04-04T08:39:26.980Z").getTime();

    expect(result[0].offset).toBe(0);
    expect(result[1].offset).toBe(
      millisecondsToNanoseconds(new Date("2025-04-04T08:39:26.985Z").getTime() - firstEventTime)
    );
    expect(result[2].offset).toBe(
      millisecondsToNanoseconds(new Date("2025-04-04T08:39:27.046Z").getTime() - firstEventTime)
    );
    expect(result[3].offset).toBe(
      millisecondsToNanoseconds(new Date("2025-04-04T08:39:27.224Z").getTime() - firstEventTime)
    );
  });

  test("should use the provided relativeStartTime when specified", () => {
    const customStartTime = new Date("2025-04-04T08:39:26.900Z").getTime();
    const result = createTimelineSpanEventsFromSpanEvents(sampleSpanEvents, true, customStartTime);

    // Offsets should be calculated relative to customStartTime
    expect(result[0].offset).toBe(
      millisecondsToNanoseconds(new Date("2025-04-04T08:39:26.980Z").getTime() - customStartTime)
    );
    expect(result[1].offset).toBe(
      millisecondsToNanoseconds(new Date("2025-04-04T08:39:26.985Z").getTime() - customStartTime)
    );
    expect(result[2].offset).toBe(
      millisecondsToNanoseconds(new Date("2025-04-04T08:39:27.046Z").getTime() - customStartTime)
    );
    expect(result[3].offset).toBe(
      millisecondsToNanoseconds(new Date("2025-04-04T08:39:27.224Z").getTime() - customStartTime)
    );
  });

  test("should handle empty span events array", () => {
    const result = createTimelineSpanEventsFromSpanEvents([], true);
    expect(result).toEqual([]);
  });

  test("should handle undefined span events", () => {
    const result = createTimelineSpanEventsFromSpanEvents(
      undefined as unknown as SpanEvent[],
      true
    );
    expect(result).toEqual([]);
  });

  test("should handle non-matching span events", () => {
    const nonMatchingEvents: SpanEvent[] = [
      {
        name: "non-trigger.dev/event",
        time: new Date("2025-04-04T08:39:27.046Z"),
        properties: { event: "something", duration: 127 },
      },
    ];

    const result = createTimelineSpanEventsFromSpanEvents(nonMatchingEvents, true);
    expect(result).toEqual([]);
  });

  test("should set marker variant correctly", () => {
    const result = createTimelineSpanEventsFromSpanEvents(sampleSpanEvents, true);

    // First event should have start-cap marker
    expect(result[0].markerVariant).toBe("start-cap");

    // Other events should have dot-hollow marker
    for (let i = 1; i < result.length; i++) {
      expect(result[i].markerVariant).toBe("dot-hollow");
    }
  });

  test("should include helpText for known events", () => {
    const result = createTimelineSpanEventsFromSpanEvents(sampleSpanEvents, true);

    expect(result.find((e) => e.name === "Dequeued")?.helpText).toBe(
      "The run was dequeued from the queue"
    );
    expect(result.find((e) => e.name === "Launched")?.helpText).toBe(
      "The process was created to run the task"
    );
    expect(result.find((e) => e.name === "Attempt created")?.helpText).toBe(
      "An attempt was created for the run"
    );
    expect(result.find((e) => e.name === "Importing src/trigger/chat.ts")?.helpText).toBe(
      "A task file was imported"
    );
  });

  test("should preserve duration from span events", () => {
    const result = createTimelineSpanEventsFromSpanEvents(sampleSpanEvents, true);

    expect(result.find((e) => e.name === "Dequeued")?.duration).toBe(0);
    expect(result.find((e) => e.name === "Launched")?.duration).toBe(127);
    expect(result.find((e) => e.name === "Attempt created")?.duration).toBe(56);
    expect(result.find((e) => e.name === "Importing src/trigger/chat.ts")?.duration).toBe(67);
  });

  test("should use fallback name for import event without file property", () => {
    const eventsWithoutFile: SpanEvent[] = [
      {
        name: "trigger.dev/start",
        time: new Date("2025-04-04T08:39:27.224Z"),
        properties: {
          event: "import",
          duration: 67,
        },
      },
    ];

    const result = createTimelineSpanEventsFromSpanEvents(eventsWithoutFile, true);

    expect(result.length).toBe(1);
    expect(result[0].name).toBe("Importing task file");
  });

  test("should include import events for non-admin when no fork event exists", () => {
    const result = createTimelineSpanEventsFromSpanEvents(eventsWithoutFork, false);

    // Without fork event, import should also be visible for non-admins
    expect(result.length).toBe(2);
    expect(result.some((event) => event.name === "Dequeued")).toBe(true);
    expect(result.some((event) => event.name === "Importing src/trigger/chat.ts")).toBe(true);

    // create_attempt should still be admin-only
    expect(result.some((event) => event.name === "Attempt created")).toBe(false);
  });

  test.skip("should filter import events for non-admin when fork event exists", () => {
    const result = createTimelineSpanEventsFromSpanEvents(sampleSpanEvents, false);

    // With fork event, import should be hidden for non-admins
    expect(result.length).toBe(2);
    expect(result.some((event) => event.name === "Dequeued")).toBe(true);
    expect(result.some((event) => event.name === "Launched")).toBe(true);
    expect(result.some((event) => event.name.includes("Importing"))).toBe(false);
  });
});
