import type { PrismaClient } from "@trigger.dev/database";
import { setupAuthenticatedEnvironment } from "../../tests/setup.js";

/**
 * A completed child run holding `output`, for the deriveFromRun branch.
 *
 * The branch's premise is that TaskRun.output holds the same string the waitpoint carried, so a
 * test that asserts it needs a real row rather than a stand-in for one.
 */
export async function seedChildRunWithOutput(
  prisma: PrismaClient,
  output: string | null,
  outputType = "application/json"
): Promise<string> {
  const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
  const suffix = env.id.slice(-10);

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

  return run.id;
}
