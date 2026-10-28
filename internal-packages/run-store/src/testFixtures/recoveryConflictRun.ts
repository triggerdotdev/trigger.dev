import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import { PostgresRunStore } from "../PostgresRunStore.js";
import type { CreateRunInput } from "../types.js";

/** Seeds one TaskRun on a dedicated run-ops database through the writer `owner`. */
export async function seedRecoveryConflictRun(owner: RunOpsPrismaClient) {
  const ids = { organizationId: "org_rc", projectId: "proj_rc", environmentId: "env_rc" };

  const input: CreateRunInput = {
    data: {
      id: "run_rc",
      engine: "V2",
      status: "PENDING",
      friendlyId: "run_friendly_rc",
      runtimeEnvironmentId: ids.environmentId,
      environmentType: "DEVELOPMENT",
      organizationId: ids.organizationId,
      projectId: ids.projectId,
      taskIdentifier: "my-task",
      payload: "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: "trace_rc",
      spanId: "span_rc",
      runTags: [],
      queue: "task/my-task",
      isTest: false,
      taskEventStore: "taskEvent",
      depth: 0,
    },
    snapshot: {
      engine: "V2",
      executionStatus: "RUN_CREATED",
      description: "Run was created",
      runStatus: "PENDING",
      environmentId: ids.environmentId,
      environmentType: "DEVELOPMENT",
      projectId: ids.projectId,
      organizationId: ids.organizationId,
    },
  };
  await new PostgresRunStore({
    prisma: owner as never,
    readOnlyPrisma: owner as never,
    schemaVariant: "dedicated",
  }).createRun(input);

  return { runId: "run_rc", friendlyId: "run_friendly_rc", environmentId: ids.environmentId };
}
