import { millisecondsToNanoseconds } from "@trigger.dev/core/v3";
import { isFailedRunStatus } from "~/v3/taskStatus";
import type { TaskRunStatus } from "@trigger.dev/database";

export type ReconcileRunData = {
    isFinished: boolean;
    status: TaskRunStatus;
    createdAt: Date;
    completedAt: Date | null;
    rootTaskRun: { createdAt: Date } | null;
};

export type ReconcileEvent = {
    id: string;
    data: {
        isPartial: boolean;
        isError: boolean;
        duration?: number | null;
    };
};

export type ReconcileResult = {
    events: any[];
    totalDuration: number;
    rootSpanStatus: "executing" | "completed" | "failed";
};

// NOTE: Clickhouse trace ingestion is eventually consistent.
// When a run is marked finished in Postgres, we reconcile the
// root span to reflect completion even if telemetry is still partial.
// This is a deliberate UI-layer tradeoff to prevent stale or "stuck"
// run states in the dashboard.
export function reconcileTraceWithRunLifecycle(
    runData: ReconcileRunData,
    rootSpanId: string,
    events: any[],
    totalDuration: number
): ReconcileResult {
    const rootEvent = events[0];
    const isActualRoot = rootEvent?.id === rootSpanId;

    const currentStatus: "executing" | "completed" | "failed" =
        isActualRoot && rootEvent
            ? rootEvent.data.isError
                ? "failed"
                : !rootEvent.data.isPartial
                    ? "completed"
                    : "executing"
            : "executing";

    if (!runData.isFinished) {
        return { events, totalDuration, rootSpanStatus: currentStatus };
    }

    const postgresRunDuration = runData.completedAt
        ? millisecondsToNanoseconds(
            runData.completedAt.getTime() -
            (runData.rootTaskRun?.createdAt ?? runData.createdAt).getTime()
        )
        : 0;

    const updatedTotalDuration = Math.max(totalDuration, postgresRunDuration);

    // We only need to potentially update the root event (the first one) if it matches our ID
    if (isActualRoot && rootEvent && rootEvent.data.isPartial) {
        const updatedEvents = [...events];
        updatedEvents[0] = {
            ...rootEvent,
            data: {
                ...rootEvent.data,
                isPartial: false,
                duration: Math.max(rootEvent.data.duration ?? 0, postgresRunDuration),
                isError: isFailedRunStatus(runData.status),
            },
        };

        return {
            events: updatedEvents,
            totalDuration: updatedTotalDuration,
            rootSpanStatus: isFailedRunStatus(runData.status) ? "failed" : "completed",
        };
    }

    return {
        events,
        totalDuration: updatedTotalDuration,
        rootSpanStatus: isFailedRunStatus(runData.status) ? "failed" : "completed",
    };
}
