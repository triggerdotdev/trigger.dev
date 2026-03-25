import { TaskRunExecutionStatus } from "@trigger.dev/database";

/**
 * Defines valid execution status transitions for the Run Engine 2.0.
 * This is a model of the state machine that governs run execution.
 */
export const EXECUTION_STATUS_TRANSITIONS: Record<
  TaskRunExecutionStatus,
  TaskRunExecutionStatus[]
> = {
  RUN_CREATED: ["QUEUED", "DELAYED"],
  DELAYED: ["QUEUED"],
  QUEUED: ["PENDING_EXECUTING", "QUEUED_EXECUTING"],
  QUEUED_EXECUTING: ["PENDING_EXECUTING", "QUEUED"],
  PENDING_EXECUTING: ["EXECUTING", "PENDING_CANCEL", "FINISHED", "QUEUED"],
  EXECUTING: ["EXECUTING_WITH_WAITPOINTS", "FINISHED", "PENDING_CANCEL", "QUEUED"],
  EXECUTING_WITH_WAITPOINTS: ["EXECUTING", "SUSPENDED", "FINISHED", "PENDING_CANCEL"],
  SUSPENDED: ["QUEUED", "PENDING_CANCEL", "FINISHED"],
  PENDING_CANCEL: ["FINISHED"],
  FINISHED: ["QUEUED"], // Retry case
};

/**
 * Validates if a transition from one status to another is valid.
 */
export function isValidTransition(
  from: TaskRunExecutionStatus,
  to: TaskRunExecutionStatus
): boolean {
  return EXECUTION_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Configuration for a snapshot in a test scenario.
 */
export interface SnapshotConfig {
  /** The execution status for this snapshot */
  status: TaskRunExecutionStatus;
  /** Number of waitpoints completed at this snapshot (cumulative) */
  completedWaitpointCount: number;
  /** Whether this snapshot has a checkpoint */
  hasCheckpoint?: boolean;
  /** Description for the snapshot */
  description?: string;
}

/**
 * A test scenario for getSnapshotsSince testing.
 */
export interface SnapshotTestScenario {
  /** Unique name for the scenario */
  name: string;
  /** Description of what this scenario tests */
  description: string;
  /** Total number of waitpoints to create */
  totalWaitpoints: number;
  /** Size of each waitpoint's output in KB */
  outputSizeKB: number;
  /** Configuration for each snapshot to create */
  snapshots: SnapshotConfig[];
  /** Which snapshot index to query "since" (0-based) */
  queryFromIndex: number;
  /** Expected number of waitpoints on the latest snapshot returned */
  expectedWaitpointsOnLatest: number;
}

/**
 * Generates test scenarios for comprehensive getSnapshotsSince testing.
 * These scenarios cover various edge cases and stress tests.
 */
export function generateTestScenarios(): SnapshotTestScenario[] {
  return [
    {
      name: "simple_no_waitpoints",
      description: "Basic run without any waitpoints",
      totalWaitpoints: 0,
      outputSizeKB: 0,
      snapshots: [
        { status: "RUN_CREATED", completedWaitpointCount: 0 },
        { status: "QUEUED", completedWaitpointCount: 0 },
        { status: "PENDING_EXECUTING", completedWaitpointCount: 0 },
        { status: "EXECUTING", completedWaitpointCount: 0 },
        { status: "FINISHED", completedWaitpointCount: 0 },
      ],
      queryFromIndex: 0,
      expectedWaitpointsOnLatest: 0,
    },
    {
      name: "single_small_waitpoint",
      description: "Single waitpoint with small output",
      totalWaitpoints: 1,
      outputSizeKB: 1,
      snapshots: [
        { status: "RUN_CREATED", completedWaitpointCount: 0 },
        { status: "QUEUED", completedWaitpointCount: 0 },
        { status: "EXECUTING", completedWaitpointCount: 0 },
        { status: "EXECUTING_WITH_WAITPOINTS", completedWaitpointCount: 0 },
        { status: "EXECUTING", completedWaitpointCount: 1 },
      ],
      queryFromIndex: 2,
      expectedWaitpointsOnLatest: 1,
    },
    {
      name: "batch_100_medium",
      description: "Medium batch with 100 waitpoints and medium outputs",
      totalWaitpoints: 100,
      outputSizeKB: 10,
      snapshots: [
        { status: "RUN_CREATED", completedWaitpointCount: 0 },
        { status: "QUEUED", completedWaitpointCount: 0 },
        { status: "EXECUTING", completedWaitpointCount: 0 },
        { status: "EXECUTING_WITH_WAITPOINTS", completedWaitpointCount: 0 },
        { status: "EXECUTING_WITH_WAITPOINTS", completedWaitpointCount: 50 },
        { status: "EXECUTING_WITH_WAITPOINTS", completedWaitpointCount: 100 },
        { status: "SUSPENDED", completedWaitpointCount: 100, hasCheckpoint: true },
        { status: "QUEUED", completedWaitpointCount: 100 },
        { status: "EXECUTING", completedWaitpointCount: 100 },
        { status: "FINISHED", completedWaitpointCount: 100 },
      ],
      queryFromIndex: 3,
      expectedWaitpointsOnLatest: 100,
    },
    {
      name: "batch_236_large_zombie_scenario",
      description:
        "Matches the zombie run scenario: 24 snapshots, 236 waitpoints, 100KB outputs each",
      totalWaitpoints: 236,
      outputSizeKB: 100,
      snapshots: [
        { status: "RUN_CREATED", completedWaitpointCount: 0 },
        { status: "QUEUED", completedWaitpointCount: 0 },
        { status: "PENDING_EXECUTING", completedWaitpointCount: 0 },
        { status: "EXECUTING", completedWaitpointCount: 0 },
        { status: "EXECUTING_WITH_WAITPOINTS", completedWaitpointCount: 0 },
        { status: "EXECUTING_WITH_WAITPOINTS", completedWaitpointCount: 50 },
        { status: "EXECUTING_WITH_WAITPOINTS", completedWaitpointCount: 100 },
        { status: "EXECUTING_WITH_WAITPOINTS", completedWaitpointCount: 150 },
        { status: "EXECUTING_WITH_WAITPOINTS", completedWaitpointCount: 200 },
        { status: "EXECUTING_WITH_WAITPOINTS", completedWaitpointCount: 236 },
        { status: "SUSPENDED", completedWaitpointCount: 236, hasCheckpoint: true },
        { status: "QUEUED", completedWaitpointCount: 236 },
        { status: "PENDING_EXECUTING", completedWaitpointCount: 236 },
        { status: "EXECUTING", completedWaitpointCount: 236 },
        { status: "EXECUTING_WITH_WAITPOINTS", completedWaitpointCount: 236 },
        { status: "SUSPENDED", completedWaitpointCount: 236, hasCheckpoint: true },
        { status: "QUEUED", completedWaitpointCount: 236 },
        { status: "PENDING_EXECUTING", completedWaitpointCount: 236 },
        { status: "EXECUTING", completedWaitpointCount: 236 },
        { status: "EXECUTING_WITH_WAITPOINTS", completedWaitpointCount: 236 },
        { status: "SUSPENDED", completedWaitpointCount: 236, hasCheckpoint: true },
        { status: "QUEUED", completedWaitpointCount: 236 },
        { status: "PENDING_EXECUTING", completedWaitpointCount: 236 },
        { status: "EXECUTING", completedWaitpointCount: 236 },
      ],
      queryFromIndex: 6,
      expectedWaitpointsOnLatest: 236,
    },
    {
      name: "batch_500_large",
      description: "Large batch requiring chunked fetching",
      totalWaitpoints: 500,
      outputSizeKB: 50,
      snapshots: [
        { status: "RUN_CREATED", completedWaitpointCount: 0 },
        { status: "QUEUED", completedWaitpointCount: 0 },
        { status: "EXECUTING", completedWaitpointCount: 0 },
        { status: "EXECUTING_WITH_WAITPOINTS", completedWaitpointCount: 0 },
        { status: "EXECUTING_WITH_WAITPOINTS", completedWaitpointCount: 100 },
        { status: "EXECUTING_WITH_WAITPOINTS", completedWaitpointCount: 250 },
        { status: "EXECUTING_WITH_WAITPOINTS", completedWaitpointCount: 400 },
        { status: "EXECUTING_WITH_WAITPOINTS", completedWaitpointCount: 500 },
        { status: "SUSPENDED", completedWaitpointCount: 500, hasCheckpoint: true },
        { status: "QUEUED", completedWaitpointCount: 500 },
        { status: "EXECUTING", completedWaitpointCount: 500 },
        { status: "EXECUTING_WITH_WAITPOINTS", completedWaitpointCount: 500 },
        { status: "SUSPENDED", completedWaitpointCount: 500, hasCheckpoint: true },
        { status: "QUEUED", completedWaitpointCount: 500 },
        { status: "EXECUTING", completedWaitpointCount: 500 },
      ],
      queryFromIndex: 5,
      expectedWaitpointsOnLatest: 500,
    },
    {
      name: "system_failure_finished",
      description: "Latest snapshot is FINISHED status with completed waitpoints",
      totalWaitpoints: 100,
      outputSizeKB: 50,
      snapshots: [
        { status: "RUN_CREATED", completedWaitpointCount: 0 },
        { status: "QUEUED", completedWaitpointCount: 0 },
        { status: "EXECUTING", completedWaitpointCount: 0 },
        { status: "EXECUTING_WITH_WAITPOINTS", completedWaitpointCount: 0 },
        { status: "EXECUTING_WITH_WAITPOINTS", completedWaitpointCount: 50 },
        { status: "EXECUTING_WITH_WAITPOINTS", completedWaitpointCount: 100 },
        { status: "EXECUTING", completedWaitpointCount: 100 },
        { status: "FINISHED", completedWaitpointCount: 100 },
      ],
      queryFromIndex: 3,
      expectedWaitpointsOnLatest: 100,
    },
    {
      name: "query_from_latest",
      description: "Querying from the latest snapshot should return empty array",
      totalWaitpoints: 10,
      outputSizeKB: 10,
      snapshots: [
        { status: "RUN_CREATED", completedWaitpointCount: 0 },
        { status: "QUEUED", completedWaitpointCount: 0 },
        { status: "EXECUTING", completedWaitpointCount: 0 },
        { status: "EXECUTING_WITH_WAITPOINTS", completedWaitpointCount: 0 },
        { status: "EXECUTING", completedWaitpointCount: 10 },
      ],
      queryFromIndex: 4, // The last snapshot
      expectedWaitpointsOnLatest: 0, // No snapshots returned, so no waitpoints
    },
    {
      name: "requeue_loop",
      description: "Multiple QUEUED->PENDING_EXECUTING cycles with waitpoints",
      totalWaitpoints: 236,
      outputSizeKB: 100,
      snapshots: [
        { status: "RUN_CREATED", completedWaitpointCount: 0 },
        { status: "QUEUED", completedWaitpointCount: 0 },
        { status: "PENDING_EXECUTING", completedWaitpointCount: 0 },
        { status: "EXECUTING", completedWaitpointCount: 0 },
        { status: "EXECUTING_WITH_WAITPOINTS", completedWaitpointCount: 0 },
        { status: "EXECUTING_WITH_WAITPOINTS", completedWaitpointCount: 236 },
        { status: "SUSPENDED", completedWaitpointCount: 236, hasCheckpoint: true },
        { status: "QUEUED", completedWaitpointCount: 236 },
        { status: "PENDING_EXECUTING", completedWaitpointCount: 236 },
        { status: "QUEUED", completedWaitpointCount: 236 }, // Requeued
        { status: "PENDING_EXECUTING", completedWaitpointCount: 236 },
        { status: "QUEUED", completedWaitpointCount: 236 }, // Requeued again
        { status: "PENDING_EXECUTING", completedWaitpointCount: 236 },
        { status: "EXECUTING", completedWaitpointCount: 236 },
        { status: "EXECUTING_WITH_WAITPOINTS", completedWaitpointCount: 236 },
        { status: "SUSPENDED", completedWaitpointCount: 236, hasCheckpoint: true },
        { status: "QUEUED", completedWaitpointCount: 236 },
        { status: "PENDING_EXECUTING", completedWaitpointCount: 236 },
        { status: "QUEUED", completedWaitpointCount: 236 }, // Requeued
        { status: "PENDING_EXECUTING", completedWaitpointCount: 236 },
        { status: "QUEUED", completedWaitpointCount: 236 }, // Requeued again
        { status: "PENDING_EXECUTING", completedWaitpointCount: 236 },
        { status: "EXECUTING", completedWaitpointCount: 236 },
        { status: "EXECUTING_WITH_WAITPOINTS", completedWaitpointCount: 236 },
        { status: "SUSPENDED", completedWaitpointCount: 236, hasCheckpoint: true },
        { status: "QUEUED", completedWaitpointCount: 236 },
        { status: "PENDING_EXECUTING", completedWaitpointCount: 236 },
        { status: "QUEUED", completedWaitpointCount: 236 }, // Requeued
        { status: "PENDING_EXECUTING", completedWaitpointCount: 236 },
        { status: "EXECUTING", completedWaitpointCount: 236 },
      ],
      queryFromIndex: 7,
      expectedWaitpointsOnLatest: 236,
    },
  ];
}
