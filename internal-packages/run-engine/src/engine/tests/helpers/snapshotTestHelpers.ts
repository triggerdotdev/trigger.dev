import { generateFriendlyId, WaitpointId } from "@trigger.dev/core/v3/isomorphic";
import {
  PrismaClient,
  TaskRunExecutionSnapshot,
  TaskRunExecutionStatus,
  Waitpoint,
  WaitpointStatus,
} from "@trigger.dev/database";
import type { AuthenticatedEnvironment } from "../setup.js";

/**
 * Generates a large output string of the specified size in KB.
 * The output is a valid JSON string to simulate realistic waitpoint output.
 */
export function generateLargeOutput(sizeKB: number): string {
  if (sizeKB <= 0) return JSON.stringify({ data: "" });

  // Create a string that's approximately the target size
  // Account for JSON wrapper overhead
  const targetBytes = sizeKB * 1024;
  const overhead = JSON.stringify({ data: "" }).length;
  const payloadSize = Math.max(0, targetBytes - overhead);

  // Generate a payload of repeating 'x' characters
  const payload = "x".repeat(payloadSize);
  return JSON.stringify({ data: payload });
}

/**
 * Creates waitpoints with specified output sizes for testing.
 */
export async function createWaitpointsWithOutput(
  prisma: PrismaClient,
  count: number,
  outputSizeKB: number,
  environmentId: string,
  projectId: string
): Promise<Waitpoint[]> {
  if (count === 0) return [];

  const output = generateLargeOutput(outputSizeKB);
  const waitpoints: Waitpoint[] = [];

  // Create waitpoints in batches to avoid overwhelming the database
  const batchSize = 50;
  for (let i = 0; i < count; i += batchSize) {
    const batchCount = Math.min(batchSize, count - i);
    const batch = await Promise.all(
      Array.from({ length: batchCount }).map(async (_, j) => {
        const waitpointIds = WaitpointId.generate();
        return prisma.waitpoint.create({
          data: {
            id: waitpointIds.id,
            friendlyId: waitpointIds.friendlyId,
            type: "MANUAL",
            status: "COMPLETED" as WaitpointStatus,
            idempotencyKey: `test-idempotency-${waitpointIds.id}`,
            userProvidedIdempotencyKey: false,
            completedAt: new Date(),
            output,
            outputType: "application/json",
            outputIsError: false,
            environmentId,
            projectId,
          },
        });
      })
    );
    waitpoints.push(...batch);
  }

  return waitpoints;
}

/**
 * Creates a snapshot directly in the database for testing purposes.
 * This bypasses the normal engine flow to allow creating specific test scenarios.
 */
export async function createTestSnapshot(
  prisma: PrismaClient,
  {
    runId,
    status,
    environmentId,
    environmentType,
    projectId,
    organizationId,
    completedWaitpointIds,
    checkpointId,
    previousSnapshotId,
    batchId,
    workerId,
    runnerId,
    attemptNumber,
  }: {
    runId: string;
    status: TaskRunExecutionStatus;
    environmentId: string;
    environmentType: "PRODUCTION" | "STAGING" | "DEVELOPMENT" | "PREVIEW";
    projectId: string;
    organizationId: string;
    completedWaitpointIds?: string[];
    checkpointId?: string;
    previousSnapshotId?: string;
    batchId?: string;
    workerId?: string;
    runnerId?: string;
    attemptNumber?: number;
  }
): Promise<TaskRunExecutionSnapshot> {
  // Determine run status based on execution status
  const runStatus = getRunStatusFromExecutionStatus(status);

  const snapshot = await prisma.taskRunExecutionSnapshot.create({
    data: {
      engine: "V2",
      executionStatus: status,
      description: `Test snapshot: ${status}`,
      previousSnapshotId,
      runId,
      runStatus,
      attemptNumber,
      batchId,
      environmentId,
      environmentType,
      projectId,
      organizationId,
      checkpointId,
      workerId,
      runnerId,
      isValid: true,
      completedWaitpoints: completedWaitpointIds
        ? {
            connect: completedWaitpointIds.map((id) => ({ id })),
          }
        : undefined,
      completedWaitpointOrder: completedWaitpointIds ?? [],
    },
  });

  // Small delay to ensure different createdAt timestamps
  await new Promise((resolve) => setTimeout(resolve, 5));

  return snapshot;
}

/**
 * Maps execution status to run status for test snapshot creation.
 */
function getRunStatusFromExecutionStatus(
  status: TaskRunExecutionStatus
): "PENDING" | "EXECUTING" | "WAITING_FOR_DEPLOY" | "COMPLETED_SUCCESSFULLY" | "SYSTEM_FAILURE" {
  switch (status) {
    case "RUN_CREATED":
    case "QUEUED":
    case "QUEUED_EXECUTING":
    case "PENDING_EXECUTING":
    case "DELAYED":
      return "PENDING";
    case "EXECUTING":
    case "EXECUTING_WITH_WAITPOINTS":
    case "SUSPENDED":
    case "PENDING_CANCEL":
      return "EXECUTING";
    case "FINISHED":
      return "COMPLETED_SUCCESSFULLY";
    default:
      return "PENDING";
  }
}

/**
 * Creates a checkpoint for testing suspended snapshots.
 */
export async function createTestCheckpoint(
  prisma: PrismaClient,
  {
    runId,
    environmentId,
    projectId,
  }: {
    runId: string;
    environmentId: string;
    projectId: string;
  }
) {
  return prisma.taskRunCheckpoint.create({
    data: {
      friendlyId: generateFriendlyId("checkpoint"),
      type: "DOCKER",
      location: `s3://test-bucket/checkpoints/${runId}`,
      imageRef: `test-image:${runId}`,
      reason: "WAIT_FOR_DURATION",
      runtimeEnvironment: {
        connect: { id: environmentId },
      },
      project: {
        connect: { id: projectId },
      },
    },
  });
}

/**
 * Interface for a complete test scenario setup result.
 */
export interface TestScenarioResult {
  run: {
    id: string;
    friendlyId: string;
  };
  snapshots: TaskRunExecutionSnapshot[];
  waitpoints: Waitpoint[];
  checkpoints: Array<{ id: string }>;
}

/**
 * Sets up a complete test scenario with run, snapshots, waitpoints, and checkpoints.
 * This creates the full database state needed for testing getSnapshotsSince.
 */
export async function setupTestScenario(
  prisma: PrismaClient,
  environment: AuthenticatedEnvironment,
  {
    totalWaitpoints,
    outputSizeKB,
    snapshotConfigs,
  }: {
    totalWaitpoints: number;
    outputSizeKB: number;
    snapshotConfigs: Array<{
      status: TaskRunExecutionStatus;
      completedWaitpointCount: number;
      hasCheckpoint?: boolean;
    }>;
  }
): Promise<TestScenarioResult> {
  // Create waitpoints first
  const waitpoints = await createWaitpointsWithOutput(
    prisma,
    totalWaitpoints,
    outputSizeKB,
    environment.id,
    environment.project.id
  );

  // Create the run
  const runFriendlyId = generateFriendlyId("run");
  const run = await prisma.taskRun.create({
    data: {
      friendlyId: runFriendlyId,
      engine: "V2",
      status: "PENDING",
      runtimeEnvironmentId: environment.id,
      environmentType: environment.type,
      organizationId: environment.organization.id,
      projectId: environment.project.id,
      taskIdentifier: "test-task",
      payload: "{}",
      payloadType: "application/json",
      traceId: `trace_${runFriendlyId}`,
      spanId: `span_${runFriendlyId}`,
      context: {},
      traceContext: {},
      isTest: false,
      queue: "task/test-task",
      workerQueue: "main",
    },
  });

  // Create snapshots in order
  const snapshots: TaskRunExecutionSnapshot[] = [];
  const checkpoints: Array<{ id: string }> = [];
  let previousSnapshotId: string | undefined;
  let attemptNumber = 0;

  for (const config of snapshotConfigs) {
    // Create checkpoint if needed
    let checkpointId: string | undefined;
    if (config.hasCheckpoint) {
      const checkpoint = await createTestCheckpoint(prisma, {
        runId: run.id,
        environmentId: environment.id,
        projectId: environment.project.id,
      });
      checkpointId = checkpoint.id;
      checkpoints.push({ id: checkpoint.id });
    }

    // Increment attempt number when entering a new execution attempt
    // PENDING_EXECUTING is the entry point - EXECUTING follows within the same attempt
    if (config.status === "PENDING_EXECUTING") {
      attemptNumber++;
    }

    // Get the waitpoint IDs that should be "completed" at this snapshot
    const completedWaitpointIds = waitpoints.slice(0, config.completedWaitpointCount).map((w) => w.id);

    const snapshot = await createTestSnapshot(prisma, {
      runId: run.id,
      status: config.status,
      environmentId: environment.id,
      environmentType: environment.type,
      projectId: environment.project.id,
      organizationId: environment.organization.id,
      completedWaitpointIds,
      checkpointId,
      previousSnapshotId,
      attemptNumber,
    });

    snapshots.push(snapshot);
    previousSnapshotId = snapshot.id;
  }

  return {
    run: { id: run.id, friendlyId: runFriendlyId },
    snapshots,
    waitpoints,
    checkpoints,
  };
}
