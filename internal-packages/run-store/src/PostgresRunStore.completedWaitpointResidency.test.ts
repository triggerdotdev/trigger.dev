import { postgresTest } from "@internal/testcontainers";
import { generateWaitpointId } from "@trigger.dev/core/v3/isomorphic";
import { describe, expect } from "vitest";
import type { PrismaClient } from "@trigger.dev/database";
import { PostgresRunStore } from "./PostgresRunStore.js";
import type { CreateRunInput } from "./types.js";

// The _completedWaitpoints join has a foreign key to "Waitpoint". A waitpoint that lives
// outside Postgres has no row there, and its snapshot link travels with the snapshot entry
// instead. Offering such an id to the insert fails the constraint, and because the insert
// shares the resume's transaction it takes the whole resume down: the run then never
// continues. So those ids have to be dropped before the statement runs, not after it fails.
describe("createExecutionSnapshot completed-waitpoint links", () => {
  postgresTest(
    "skips a waitpoint id that has no Postgres row instead of violating the foreign key",
    async ({ prisma }) => {
      const { organization, project, environment } = await seedEnvironment(prisma);
      const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const runId = "run_mixed_links";

      await store.createRun(
        buildCreateRunInput({
          runId,
          organizationId: organization.id,
          projectId: project.id,
          runtimeEnvironmentId: environment.id,
        })
      );

      const legacyWaitpoint = await prisma.waitpoint.create({
        data: {
          id: "waitpoint_legacy_link",
          friendlyId: "waitpoint_legacy_link",
          type: "MANUAL",
          status: "COMPLETED",
          idempotencyKey: "legacy-link",
          userProvidedIdempotencyKey: false,
          environmentId: environment.id,
          projectId: project.id,
        },
      });
      const storeWaitpointId = generateWaitpointId("MANUAL");

      const snapshot = await store.createExecutionSnapshot(
        {
          run: { id: runId, status: "PENDING", attemptNumber: 1 },
          snapshot: { executionStatus: "EXECUTING", description: "resumed" },
          environmentId: environment.id,
          environmentType: "PRODUCTION",
          projectId: project.id,
          organizationId: organization.id,
          completedWaitpoints: [{ id: legacyWaitpoint.id }, { id: storeWaitpointId }],
        },
        prisma
      );

      const links = await prisma.$queryRaw<{ B: string }[]>`
        SELECT "B" FROM "_completedWaitpoints" WHERE "A" = ${snapshot.id}`;

      expect(links.map((link) => link.B)).toEqual([legacyWaitpoint.id]);
    }
  );
});

async function seedEnvironment(prisma: PrismaClient) {
  const organization = await prisma.organization.create({
    data: {
      title: "Test Organization",
      slug: "test-organization",
    },
  });

  const project = await prisma.project.create({
    data: {
      name: "Test Project",
      slug: "test-project",
      externalRef: "proj_1234",
      organizationId: organization.id,
    },
  });

  const environment = await prisma.runtimeEnvironment.create({
    data: {
      type: "DEVELOPMENT",
      slug: "dev",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: "tr_dev_apikey",
      pkApiKey: "pk_dev_apikey",
      shortcode: "short_code",
    },
  });

  return { organization, project, environment };
}

function buildCreateRunInput(params: {
  runId: string;
  organizationId: string;
  projectId: string;
  runtimeEnvironmentId: string;
}): CreateRunInput {
  return {
    data: {
      id: params.runId,
      engine: "V2",
      status: "PENDING",
      friendlyId: "run_friendly_1",
      runtimeEnvironmentId: params.runtimeEnvironmentId,
      environmentType: "DEVELOPMENT",
      organizationId: params.organizationId,
      projectId: params.projectId,
      taskIdentifier: "my-task",
      payload: "{}",
      payloadType: "application/json",
      traceContext: {},
      traceId: "trace_1",
      spanId: "span_1",
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
      environmentId: params.runtimeEnvironmentId,
      environmentType: "DEVELOPMENT",
      projectId: params.projectId,
      organizationId: params.organizationId,
    },
  };
}
