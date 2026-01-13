import { vi, describe, it, expect } from "vitest";

vi.mock("../app/env.server", () => ({
    env: {
        MAXIMUM_LIVE_RELOADING_EVENTS: 1000,
    },
}));

vi.mock("../app/db.server", () => ({
    prisma: {},
    $replica: {},
    $transaction: vi.fn(),
}));

vi.mock("../app/v3/eventRepository/index.server", () => ({
    resolveEventRepositoryForStore: vi.fn(),
}));

vi.mock("../app/v3/taskEventStore.server", () => ({
    getTaskEventStoreTableForRun: vi.fn(),
}));

vi.mock("../app/utils/username", () => ({
    getUsername: vi.fn(),
}));

import { reconcileTraceWithRunLifecycle } from "../app/presenters/v3/reconcileTrace.server";
import { millisecondsToNanoseconds } from "@trigger.dev/core/v3";

describe("reconcileTraceWithRunLifecycle", () => {
    const rootSpanId = "root-span-id";
    const createdAt = new Date("2024-01-01T00:00:00Z");
    const completedAt = new Date("2024-01-01T00:00:05Z");

    const runData: any = {
        isFinished: true,
        status: "COMPLETED_SUCCESSFULLY",
        createdAt,
        completedAt,
        rootTaskRun: null,
    };

    const initialEvents = [
        {
            id: rootSpanId,
            data: {
                isPartial: true,
                duration: millisecondsToNanoseconds(1000), // 1s, less than the 5s run duration
                isError: false,
            },
        },
        {
            id: "child-span-id",
            data: {
                isPartial: false,
                duration: millisecondsToNanoseconds(500),
                isError: false,
            },
        },
    ];

    it("should reconcile a finished run with lagging partial telemetry", () => {
        const totalDuration = millisecondsToNanoseconds(1000);
        const result = reconcileTraceWithRunLifecycle(runData, rootSpanId, initialEvents as any, totalDuration);

        expect(result.rootSpanStatus).toBe("completed");

        const rootEvent = result.events.find((e: any) => e.id === rootSpanId);
        expect(rootEvent?.data.isPartial).toBe(false);
        // 5s duration = 5000ms
        expect(rootEvent?.data.duration).toBeGreaterThanOrEqual(millisecondsToNanoseconds(5000));
        expect(result.totalDuration).toBeGreaterThanOrEqual(millisecondsToNanoseconds(5000));
    });

    it("should not override duration if Clickhouse already has a longer finished duration", () => {
        const longDuration = millisecondsToNanoseconds(10000);
        const finishedEvents = [
            {
                id: rootSpanId,
                data: {
                    isPartial: false,
                    duration: longDuration,
                    isError: false,
                },
            },
        ];

        const result = reconcileTraceWithRunLifecycle(runData, rootSpanId, finishedEvents as any, longDuration);

        const rootEvent = result.events.find((e: any) => e.id === rootSpanId);
        expect(rootEvent?.data.duration).toBe(longDuration);
        expect(rootEvent?.data.isPartial).toBe(false);
        expect(result.totalDuration).toBe(longDuration);
    });

    it("should handle unfinished runs without modification", () => {
        const unfinishedRun = { ...runData, isFinished: false, completedAt: null };
        const totalDuration = millisecondsToNanoseconds(1000);
        const result = reconcileTraceWithRunLifecycle(unfinishedRun, rootSpanId, initialEvents as any, totalDuration);

        expect(result.rootSpanStatus).toBe("executing");

        const rootEvent = result.events.find((e: any) => e.id === rootSpanId);
        expect(rootEvent?.data.isPartial).toBe(true);
        expect(rootEvent?.data.duration).toBe(millisecondsToNanoseconds(1000));
    });

    it("should reconcile failed runs correctly", () => {
        const failedRun = { ...runData, status: "COMPLETED_WITH_ERRORS" };
        const result = reconcileTraceWithRunLifecycle(failedRun, rootSpanId, initialEvents as any, millisecondsToNanoseconds(1000));

        expect(result.rootSpanStatus).toBe("failed");
        const rootEvent = result.events.find((e: any) => e.id === rootSpanId);
        expect(rootEvent?.data.isError).toBe(true);
        expect(rootEvent?.data.isPartial).toBe(false);
    });

    it("should use rootTaskRun createdAt if available for duration calculation", () => {
        const rootTaskCreatedAt = new Date("2023-12-31T23:59:50Z"); // 10s before run.createdAt
        const runDataWithRoot: any = {
            ...runData,
            rootTaskRun: { createdAt: rootTaskCreatedAt },
        };

        const result = reconcileTraceWithRunLifecycle(runDataWithRoot, rootSpanId, initialEvents as any, millisecondsToNanoseconds(1000));

        // Duration should be from 23:59:50 to 00:00:05 = 15s
        const rootEvent = result.events.find((e: any) => e.id === rootSpanId);
        expect(rootEvent?.data.duration).toBeGreaterThanOrEqual(millisecondsToNanoseconds(15000));
        expect(result.totalDuration).toBeGreaterThanOrEqual(millisecondsToNanoseconds(15000));
    });

    it("should handle missing root span gracefully", () => {
        const result = reconcileTraceWithRunLifecycle(runData, "non-existent-id", initialEvents as any, millisecondsToNanoseconds(1000));

        expect(result.rootSpanStatus).toBe("completed");
        expect(result.events).toEqual(initialEvents);
        // totalDuration should still be updated to postgres duration even if root span is missing from events list
        expect(result.totalDuration).toBeGreaterThanOrEqual(millisecondsToNanoseconds(5000));
    });
});
