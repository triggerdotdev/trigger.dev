import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect } from "vitest";

// The env-scoped snapshot read the platform now performs for worker actions. Mirrors the where clause
// in getLatestExecutionSnapshot so this exercises the real select against the schema.
async function readLatestSnapshot(prisma: PrismaClient, runId: string, environmentId?: string) {
  return prisma.taskRunExecutionSnapshot.findFirst({
    where: { runId, isValid: true, ...(environmentId ? { environmentId } : {}) },
    orderBy: { createdAt: "desc" },
  });
}

async function seed(prisma: PrismaClient) {
  const org = await prisma.organization.create({
    data: { title: "Org", slug: `org-${Date.now()}` },
  });
  const project = await prisma.project.create({
    data: {
      name: "Project",
      slug: `proj-${Date.now()}`,
      externalRef: `proj_${Date.now()}`,
      organizationId: org.id,
    },
  });
  const env = await prisma.runtimeEnvironment.create({
    data: {
      type: "PRODUCTION",
      slug: "prod",
      projectId: project.id,
      organizationId: org.id,
      apiKey: "api_key",
      pkApiKey: "pk_api_key",
      shortcode: "short",
    },
  });

  const run = await prisma.taskRun.create({
    data: {
      friendlyId: `run_${Date.now()}`,
      taskIdentifier: "test-task",
      payload: "{}",
      payloadType: "application/json",
      traceId: "trace_1",
      spanId: "span_1",
      queue: "task/test-task",
      runtimeEnvironmentId: env.id,
      projectId: project.id,
      organizationId: org.id,
    },
  });

  await prisma.taskRunExecutionSnapshot.create({
    data: {
      engine: "V2",
      executionStatus: "RUN_CREATED",
      description: "seed",
      runId: run.id,
      runStatus: "PENDING",
      environmentId: env.id,
      environmentType: "PRODUCTION",
      projectId: project.id,
      organizationId: org.id,
    },
  });

  return { env, run };
}

describe("env-scoped snapshot read against a real DB row", () => {
  postgresTest(
    "returns the snapshot for the matching env and nothing for another",
    async ({ prisma }) => {
      const { env, run } = await seed(prisma as PrismaClient);

      // No env scoping -> found (internal callers)
      expect(await readLatestSnapshot(prisma as PrismaClient, run.id)).not.toBeNull();

      // Matching env -> found
      expect(await readLatestSnapshot(prisma as PrismaClient, run.id, env.id)).not.toBeNull();

      // Different env -> not found (rejected as a tenant boundary)
      expect(
        await readLatestSnapshot(prisma as PrismaClient, run.id, "clenvdoesnotexist000000000")
      ).toBeNull();
    }
  );
});
