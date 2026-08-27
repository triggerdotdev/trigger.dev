// A caller-supplied snapshot id must survive into Postgres, so the decorator can own the id and both
// stores hold the same one under dual-write. Absent, Prisma's @default(cuid()) still supplies it.
import { describe, expect } from "vitest";
import { postgresTest } from "@internal/testcontainers";
import { generateInternalId } from "@trigger.dev/core/v3/isomorphic";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { setupSnapshotIdFixture } from "./testFixtures/snapshotIdFixture.js";

describe("PostgresRunStore caller-supplied snapshot id", () => {
  postgresTest("completeAttemptSuccess writes the supplied id", async ({ prisma }) => {
    const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
    const { run, env } = await setupSnapshotIdFixture(prisma);
    const id = generateInternalId();

    await store.completeAttemptSuccess(
      run.id,
      {
        completedAt: new Date(),
        outputType: "application/json",
        usageDurationMs: 1,
        costInCents: 0,
        snapshot: {
          id,
          executionStatus: "FINISHED",
          description: "Run completed",
          runStatus: "COMPLETED_SUCCESSFULLY",
          attemptNumber: 1,
          environmentId: env.id,
          environmentType: env.type,
          projectId: env.projectId,
          organizationId: env.organizationId,
        },
      },
      { select: { id: true } }
    );

    const snapshot = await prisma.taskRunExecutionSnapshot.findFirst({ where: { id } });
    expect(snapshot).not.toBeNull();
    expect(snapshot!.runId).toBe(run.id);
  });

  postgresTest("expireRun writes the supplied id", async ({ prisma }) => {
    const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
    const { run, env } = await setupSnapshotIdFixture(prisma);
    const id = generateInternalId();

    await store.expireRun(
      run.id,
      {
        error: { type: "STRING_ERROR", raw: "expired" },
        completedAt: new Date(),
        expiredAt: new Date(),
        snapshot: {
          id,
          engine: "V2",
          executionStatus: "FINISHED",
          description: "Run expired",
          runStatus: "EXPIRED",
          environmentId: env.id,
          environmentType: env.type,
          projectId: env.projectId,
          organizationId: env.organizationId,
        },
      },
      { select: { id: true } }
    );

    expect(await prisma.taskRunExecutionSnapshot.findFirst({ where: { id } })).not.toBeNull();
  });

  postgresTest("expireParkedRun writes the supplied id", async ({ prisma }) => {
    const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
    const { run, env } = await setupSnapshotIdFixture(prisma, { status: "PENDING_VERSION" });
    const id = generateInternalId();

    const result = await store.expireParkedRun(run.id, {
      error: { type: "STRING_ERROR", raw: "expired" },
      completedAt: new Date(),
      expiredAt: new Date(),
      statusReason: "VERSION_NEVER_ARRIVED",
      snapshot: {
        id,
        engine: "V2",
        executionStatus: "FINISHED",
        description: "Parked run expired",
        runStatus: "EXPIRED",
        environmentId: env.id,
        environmentType: env.type,
        projectId: env.projectId,
        organizationId: env.organizationId,
      },
    });

    expect(result.count).toBe(1);
    expect(await prisma.taskRunExecutionSnapshot.findFirst({ where: { id } })).not.toBeNull();
  });

  postgresTest("rescheduleRun writes the supplied id", async ({ prisma }) => {
    const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
    const { run, env } = await setupSnapshotIdFixture(prisma, { status: "DELAYED" });
    const id = generateInternalId();

    await store.rescheduleRun(run.id, {
      delayUntil: new Date(Date.now() + 60_000),
      snapshot: {
        id,
        environmentId: env.id,
        environmentType: env.type,
        projectId: env.projectId,
        organizationId: env.organizationId,
      },
    });

    expect(await prisma.taskRunExecutionSnapshot.findFirst({ where: { id } })).not.toBeNull();
  });

  postgresTest("createExecutionSnapshot writes the supplied id", async ({ prisma }) => {
    const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
    const { run, env } = await setupSnapshotIdFixture(prisma);
    const id = generateInternalId();

    const created = await store.createExecutionSnapshot({
      id,
      run: { id: run.id, status: "EXECUTING", attemptNumber: 1 },
      snapshot: { executionStatus: "EXECUTING", description: "Run started" },
      environmentId: env.id,
      environmentType: env.type,
      projectId: env.projectId,
      organizationId: env.organizationId,
    });

    expect(created.id).toBe(id);
  });

  postgresTest("an absent id still gets a generated one", async ({ prisma }) => {
    const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
    const { run, env } = await setupSnapshotIdFixture(prisma);

    const created = await store.createExecutionSnapshot({
      run: { id: run.id, status: "EXECUTING", attemptNumber: 1 },
      snapshot: { executionStatus: "EXECUTING", description: "Run started" },
      environmentId: env.id,
      environmentType: env.type,
      projectId: env.projectId,
      organizationId: env.organizationId,
    });

    expect(created.id).toMatch(/^c[a-z0-9]{24}$/);
  });
});
