import type { PrismaClient } from "@trigger.dev/database";
import { setupAuthenticatedEnvironment } from "../../tests/setup.js";

/**
 * Completed child runs holding `output`, for the deriveFromRun branch.
 *
 * The branch's premise is that TaskRun.output holds the same string the waitpoint carried, so a
 * test that asserts it needs real rows rather than stand-ins for them.
 *
 * All the runs share ONE environment, because `setupAuthenticatedEnvironment` hardcodes the
 * organization slug and the column is unique: calling it once per run fails on the second.
 */
export async function seedChildRunsWithOutputs(
  prisma: PrismaClient,
  outputs: (string | null)[],
  outputType = "application/json"
): Promise<string[]> {
  const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
  const envSuffix = env.id.slice(-10);
  const ids: string[] = [];

  for (const [i, output] of outputs.entries()) {
    // Unique per run, not per environment: friendlyId is a unique column and every run here
    // shares the one environment.
    const suffix = `${envSuffix}${i}`;

    const run = await prisma.taskRun.create({
      data: {
        engine: "V2",
        status: "COMPLETED_SUCCESSFULLY",
        friendlyId: `run_child${suffix}`,
        runtimeEnvironmentId: env.id,
        environmentType: env.type,
        organizationId: env.organization.id,
        projectId: env.project.id,
        taskIdentifier: "child-task",
        payload: "{}",
        payloadType: "application/json",
        traceContext: {},
        traceId: `trace_${suffix}`,
        spanId: `span_${suffix}`,
        queue: "task/child-task",
        isTest: false,
        taskEventStore: "taskEvent",
        depth: 1,
        ...(output !== null && { output, outputType }),
      },
      select: { id: true },
    });

    ids.push(run.id);
  }

  return ids;
}

/** One child run, for the cases that only need one. */
export async function seedChildRunWithOutput(
  prisma: PrismaClient,
  output: string | null,
  outputType = "application/json"
): Promise<string> {
  const [id] = await seedChildRunsWithOutputs(prisma, [output], outputType);
  return id!;
}
