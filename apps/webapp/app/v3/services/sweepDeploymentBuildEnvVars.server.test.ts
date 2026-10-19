import { postgresTest } from "@internal/testcontainers";
import { type PrismaClient, type WorkerDeploymentStatus } from "@trigger.dev/database";
import { expect } from "vitest";
import { $transaction } from "~/db.server";
import {
  createRuntimeEnvironment,
  createTestOrgProjectWithMember,
  uniqueId,
} from "../../../test/fixtures/environmentVariablesFixtures";
import {
  clearExpiredBuildEnvVarsPage,
  sweepExpiredBuildEnvVars,
} from "./sweepDeploymentBuildEnvVars.server";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-13T12:00:00Z");
const CUTOFF = new Date(NOW.getTime() - 7 * DAY);
const envelope = { nonce: "n", ciphertext: "c", tag: "t" };

async function seed(prisma: PrismaClient) {
  const { project, organization } = await createTestOrgProjectWithMember(prisma);
  const environment = await createRuntimeEnvironment(prisma, {
    projectId: project.id,
    organizationId: organization.id,
    type: "PRODUCTION",
  });
  return (createdAt: Date, withEnvelope = true, status: WorkerDeploymentStatus = "FAILED") =>
    prisma.workerDeployment.create({
      data: {
        environmentId: environment.id,
        projectId: project.id,
        createdAt,
        status,
        version: uniqueId("version"),
        friendlyId: uniqueId("deployment"),
        shortCode: uniqueId("short"),
        contentHash: "hash",
        buildEnvVars: withEnvelope ? envelope : undefined,
      },
    });
}

async function envelopes(prisma: PrismaClient, ids: string[]) {
  const rows = await prisma.workerDeployment.findMany({
    where: { id: { in: ids } },
    select: { id: true, buildEnvVars: true },
  });
  return Object.fromEntries(rows.map((row) => [row.id, row.buildEnvVars]));
}

postgresTest(
  "clears envelopes older than the window across pages and keeps the rest",
  async ({ prisma }) => {
    const deployment = await seed(prisma);
    const expired = await deployment(new Date(CUTOFF.getTime() - 1), true, "FAILED");
    const expiredDeployed = await deployment(new Date(CUTOFF.getTime() - DAY), true, "DEPLOYED");
    const stuckInFlight = await deployment(new Date(CUTOFF.getTime() - DAY), true, "BUILDING");
    const atCutoff = await deployment(CUTOFF);
    const recent = await deployment(new Date(NOW.getTime() - DAY));
    const withoutEnvelope = await deployment(new Date(CUTOFF.getTime() - DAY), false);

    const result = await sweepExpiredBuildEnvVars(prisma, {
      windowDays: 7,
      batchSize: 2,
      now: NOW,
    });

    expect(result).toEqual({ cleared: 3, pages: 2 });
    expect(
      await envelopes(prisma, [
        expired.id,
        expiredDeployed.id,
        stuckInFlight.id,
        atCutoff.id,
        recent.id,
        withoutEnvelope.id,
      ])
    ).toEqual({
      [expired.id]: null,
      [expiredDeployed.id]: null,
      [stuckInFlight.id]: null,
      [atCutoff.id]: envelope,
      [recent.id]: envelope,
      [withoutEnvelope.id]: null,
    });
  }
);

postgresTest("skips rows locked by another transaction", async ({ prisma }) => {
  const deployment = await seed(prisma);
  const old = new Date(CUTOFF.getTime() - DAY);
  const locked = await deployment(old);
  const free = await deployment(old);

  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let lockHeld!: () => void;
  const held = new Promise<void>((resolve) => (lockHeld = resolve));

  const holder = $transaction(prisma, "holdDeploymentLock", async (tx) => {
    await tx.$queryRaw`SELECT id FROM "WorkerDeployment" WHERE id = ${locked.id} FOR UPDATE`;
    lockHeld();
    await released;
  });

  await held;
  expect(await clearExpiredBuildEnvVarsPage(prisma, CUTOFF, 10)).toBe(1);
  release();
  await holder;

  expect(await envelopes(prisma, [locked.id, free.id])).toEqual({
    [locked.id]: envelope,
    [free.id]: null,
  });
});
