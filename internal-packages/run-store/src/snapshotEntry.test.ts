// These mappings are values Postgres derives rather than receives. If either side changes and the
// other does not, dual-write silently stores two different documents for one snapshot. The parity
// suite next to this file checks the same thing against a real Postgres row; this one pins the
// rules on their own, so a failure says which rule broke.
import { describe, expect, it } from "vitest";
import {
  entryFromCompletion,
  entryFromCreateExecutionSnapshot,
  entryFromCreateRun,
  entryFromExpire,
  entryFromLock,
  entryFromReschedule,
  isTerminalEntry,
} from "./snapshotEntry.js";

const ctx = { id: "snap_1", runId: "run_1", createdAt: new Date("2026-08-24T00:00:00.000Z") };
const scope = {
  environmentId: "env_1",
  environmentType: "DEVELOPMENT" as const,
  projectId: "proj_1",
  organizationId: "org_1",
};

describe("snapshotEntry derived values", () => {
  it("rewrites a DEQUEUED run status to PENDING", () => {
    const entry = entryFromCreateExecutionSnapshot(ctx, {
      run: { id: "run_1", status: "DEQUEUED", attemptNumber: 1 },
      snapshot: { executionStatus: "PENDING_EXECUTING", description: "d" },
      ...scope,
    });

    expect(entry.runStatus).toBe("PENDING");
  });

  it("keeps every other run status unchanged", () => {
    const entry = entryFromCreateExecutionSnapshot(ctx, {
      run: { id: "run_1", status: "EXECUTING", attemptNumber: 1 },
      snapshot: { executionStatus: "EXECUTING", description: "d" },
      ...scope,
    });

    expect(entry.runStatus).toBe("EXECUTING");
  });

  it("applies the lock site's hard-coded values", () => {
    const entry = entryFromLock(ctx, {
      id: "snap_1",
      previousSnapshotId: "snap_0",
      attemptNumber: 2,
      completedWaitpointIds: [],
      completedWaitpointOrder: [],
      ...scope,
    });

    expect(entry.executionStatus).toBe("PENDING_EXECUTING");
    expect(entry.description).toBe("Run was dequeued for execution");
    expect(entry.runStatus).toBe("PENDING");
    expect(entry.engine).toBe("V2");
    expect(entry.previousSnapshotId).toBe("snap_0");
    expect(entry.attemptNumber).toBe(2);
  });

  it("applies the reschedule defaults", () => {
    const entry = entryFromReschedule(ctx, { ...scope });

    expect(entry.executionStatus).toBe("DELAYED");
    expect(entry.runStatus).toBe("DELAYED");
    expect(entry.description).toBe("Delayed run was rescheduled to a future date");
  });

  it("prefers a supplied reschedule value over the default", () => {
    const entry = entryFromReschedule(ctx, {
      ...scope,
      executionStatus: "QUEUED",
      runStatus: "PENDING",
      description: "custom",
    });

    expect(entry.executionStatus).toBe("QUEUED");
    expect(entry.runStatus).toBe("PENDING");
    expect(entry.description).toBe("custom");
  });

  it("sets engine V2 on a completion, which Postgres leaves to the column default", () => {
    const entry = entryFromCompletion(ctx, {
      executionStatus: "FINISHED",
      description: "Run completed",
      runStatus: "COMPLETED_SUCCESSFULLY",
      attemptNumber: 1,
      ...scope,
    });

    expect(entry.engine).toBe("V2");
  });

  it("carries a null completion attemptNumber through as null", () => {
    const entry = entryFromCompletion(ctx, {
      executionStatus: "FINISHED",
      description: "Run completed",
      runStatus: "COMPLETED_SUCCESSFULLY",
      attemptNumber: null,
      ...scope,
    });

    expect(entry.attemptNumber).toBeNull();
  });

  it("omits an absent optional rather than writing undefined into the document", () => {
    const entry = entryFromExpire(ctx, {
      engine: "V2",
      executionStatus: "FINISHED",
      description: "Run expired",
      runStatus: "EXPIRED",
      ...scope,
    });

    expect(Object.keys(entry)).not.toContain("workerId");
    expect(Object.keys(entry)).not.toContain("attemptNumber");
    expect(JSON.parse(JSON.stringify(entry))).toEqual(entry);
  });

  it("reports a FINISHED entry as terminal and any other as not", () => {
    const finished = entryFromCompletion(ctx, {
      executionStatus: "FINISHED",
      description: "Run completed",
      runStatus: "COMPLETED_SUCCESSFULLY",
      attemptNumber: 1,
      ...scope,
    });
    const running = entryFromCreateExecutionSnapshot(ctx, {
      run: { id: "run_1", status: "EXECUTING", attemptNumber: 1 },
      snapshot: { executionStatus: "EXECUTING", description: "d" },
      ...scope,
    });

    expect(isTerminalEntry(finished)).toBe(true);
    expect(isTerminalEntry(running)).toBe(false);
  });

  it("serialises createdAt as an ISO string", () => {
    const entry = entryFromReschedule(ctx, { ...scope });

    expect(entry.createdAt).toBe("2026-08-24T00:00:00.000Z");
  });

  it("carries the birth site's worker and runner ids", () => {
    const entry = entryFromCreateRun(ctx, {
      engine: "V2",
      executionStatus: "RUN_CREATED",
      description: "Run was created",
      runStatus: "PENDING",
      workerId: "worker_1",
      runnerId: "runner_1",
      ...scope,
    });

    expect(entry.workerId).toBe("worker_1");
    expect(entry.runnerId).toBe("runner_1");
    expect(entry.executionStatus).toBe("RUN_CREATED");
  });

  it("never sets the reserved completedWaitpoints field", () => {
    const built = [
      entryFromReschedule(ctx, { ...scope }),
      entryFromLock(ctx, {
        id: "snap_1",
        previousSnapshotId: "snap_0",
        completedWaitpointIds: ["w_1"],
        completedWaitpointOrder: ["w_1"],
        ...scope,
      }),
      entryFromCreateExecutionSnapshot(ctx, {
        run: { id: "run_1", status: "EXECUTING", attemptNumber: 1 },
        snapshot: { executionStatus: "EXECUTING", description: "d" },
        completedWaitpoints: [{ id: "w_1", index: 0 }],
        ...scope,
      }),
    ];

    // The append script mints the pointer as a sidecar field, and rejects an entry that carries one.
    for (const entry of built) {
      expect(entry.completedWaitpoints).toBeUndefined();
    }
  });
});
