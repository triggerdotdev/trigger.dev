// The caller's instant must land in BOTH timestamp columns, on BOTH schema variants.
//
// `updatedAt` is declared `@updatedAt`, which Prisma manages itself, so whether an explicit value
// survives a create is a property of the client rather than of the schema. The two variants are
// separately generated clients over separately declared schemas, so agreeing declarations are not
// evidence that they agree in behaviour. This asserts it on each.
//
// It matters because the decorator writes one instant to both stores. If Prisma overrode it here,
// Postgres and Redis would hold different values for a column the comparator checks for equality,
// on every snapshot.
import { heteroPostgresTest, heteroRunOpsPostgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import { generateInternalId } from "@trigger.dev/core/v3/isomorphic";
import { describe, expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";

type AnyClient = PrismaClient | RunOpsPrismaClient;

/** Five minutes in the past, so a column default could never coincide with it. */
const STAMP = new Date(Date.now() - 5 * 60 * 1000);

async function writeSnapshot(
  prisma: AnyClient,
  schemaVariant: "legacy" | "dedicated",
  suffix: string
) {
  const scope =
    schemaVariant === "dedicated"
      ? {
          environmentId: `env_${suffix}`,
          projectId: `proj_${suffix}`,
          organizationId: `org_${suffix}`,
        }
      : await seedLegacyScope(prisma as PrismaClient, suffix);

  const store = new PostgresRunStore({
    prisma: prisma as never,
    readOnlyPrisma: prisma as never,
    schemaVariant,
  });

  const runId = generateInternalId();
  const id = generateInternalId();

  await (prisma as PrismaClient).taskRun.create({
    data: {
      id: runId,
      engine: "V2",
      status: "PENDING",
      friendlyId: `run_${suffix}`,
      runtimeEnvironmentId: scope.environmentId,
      environmentType: "DEVELOPMENT",
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      taskIdentifier: "my-task",
      payload: "{}",
      payloadType: "application/json",
      traceContext: {},
      traceId: `trace_${suffix}`,
      spanId: `span_${suffix}`,
      queue: "task/my-task",
      isTest: false,
      taskEventStore: "taskEvent",
      depth: 0,
    } as never,
  });

  await store.createExecutionSnapshot({
    id,
    createdAt: STAMP,
    run: { id: runId, status: "EXECUTING", attemptNumber: 1 },
    snapshot: { executionStatus: "EXECUTING", description: "Run started" },
    environmentId: scope.environmentId,
    environmentType: "DEVELOPMENT",
    projectId: scope.projectId,
    organizationId: scope.organizationId,
  });

  return (prisma as PrismaClient).taskRunExecutionSnapshot.findFirstOrThrow({ where: { id } });
}

async function seedLegacyScope(prisma: PrismaClient, suffix: string) {
  const organization = await prisma.organization.create({
    data: { title: `Org ${suffix}`, slug: `org-${suffix}` },
  });
  const project = await prisma.project.create({
    data: {
      name: `Project ${suffix}`,
      slug: `project-${suffix}`,
      externalRef: `proj_${suffix}`,
      organizationId: organization.id,
    },
  });
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      type: "DEVELOPMENT",
      slug: `dev-${suffix}`,
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_dev_${suffix}`,
      pkApiKey: `pk_dev_${suffix}`,
      shortcode: `short_${suffix}`,
    },
  });
  return {
    environmentId: environment.id,
    projectId: project.id,
    organizationId: organization.id,
  };
}

describe("snapshot timestamps are the caller's, on both schema variants", () => {
  heteroPostgresTest("legacy client honours the supplied instant", async ({ prisma14 }) => {
    const row = await writeSnapshot(prisma14, "legacy", "tsleg");

    expect(row.createdAt.toISOString()).toBe(STAMP.toISOString());
    // The one Prisma manages. If it overrode the value, the two stores would disagree here on
    // every snapshot.
    expect(row.updatedAt.toISOString()).toBe(STAMP.toISOString());
  });

  heteroRunOpsPostgresTest(
    "dedicated client honours the supplied instant",
    async ({ prisma17 }) => {
      const row = await writeSnapshot(prisma17, "dedicated", "tsded");

      expect(row.createdAt.toISOString()).toBe(STAMP.toISOString());
      expect(row.updatedAt.toISOString()).toBe(STAMP.toISOString());
    }
  );
});
