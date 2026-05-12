import type { PrismaClient, TaskRun } from "@trigger.dev/database";
import { customAlphabet, nanoid } from "nanoid";

const idGenerator = customAlphabet("123456789abcdefghijkmnopqrstuvwxyz", 21);

export interface SeededRun {
  run: TaskRun;
  runFriendlyId: string; // `run_...`
  batchFriendlyId?: string; // `batch_...` when { withBatch: true }
}

// Minimum-viable TaskRun for auth-layer e2e tests — enough fields for
// ApiRetrieveRunPresenter.findRun to return it and for the authorization.resource
// callback to populate `runs`, `tags`, `batch`, `tasks` keys.
export async function seedTestRun(
  prisma: PrismaClient,
  opts: {
    environmentId: string;
    projectId: string;
    runTags?: string[];
    withBatch?: boolean;
  }
): Promise<SeededRun> {
  const runInternalId = idGenerator();
  const runFriendlyId = `run_${runInternalId}`;

  let batchInternalId: string | undefined;
  if (opts.withBatch) {
    batchInternalId = idGenerator();
    await prisma.batchTaskRun.create({
      data: {
        id: batchInternalId,
        friendlyId: `batch_${batchInternalId}`,
        runtimeEnvironmentId: opts.environmentId,
      },
    });
  }

  const run = await prisma.taskRun.create({
    data: {
      id: runInternalId,
      friendlyId: runFriendlyId,
      taskIdentifier: "test-task",
      payload: "{}",
      payloadType: "application/json",
      traceId: nanoid(32),
      spanId: nanoid(16),
      queue: "task/test-task",
      runtimeEnvironmentId: opts.environmentId,
      projectId: opts.projectId,
      runTags: opts.runTags ?? [],
      batchId: batchInternalId,
    },
  });

  return {
    run,
    runFriendlyId,
    batchFriendlyId: batchInternalId ? `batch_${batchInternalId}` : undefined,
  };
}
