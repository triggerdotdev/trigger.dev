import { postgresTest } from "@internal/testcontainers";
import { Prisma, type PrismaClient, type WorkerDeploymentStatus } from "@trigger.dev/database";
import { describe, expect, it, vi } from "vitest";
import {
  deploymentActivityByDay,
  deploymentDaySql,
  deploymentsOnDay,
  safeTimeZone,
} from "~/v3/deploymentActivity.server";
import {
  createRuntimeEnvironment,
  createTestOrgProjectWithMember,
  uniqueId,
} from "./fixtures/environmentVariablesFixtures";

vi.setConfig({ testTimeout: 60_000 });

const schema = Prisma.sql([`public`]);

type Environment = { id: string; projectId: string };

async function createEnvironment(prisma: PrismaClient): Promise<Environment> {
  const { organization, project } = await createTestOrgProjectWithMember(prisma);
  return createRuntimeEnvironment(prisma, {
    projectId: project.id,
    organizationId: organization.id,
    type: "PRODUCTION",
  });
}

async function createDeployment(
  prisma: PrismaClient,
  environment: Environment,
  createdAt: string,
  status: WorkerDeploymentStatus = "DEPLOYED"
) {
  const shortCode = uniqueId("short");
  await prisma.workerDeployment.create({
    data: {
      friendlyId: uniqueId("deployment"),
      shortCode,
      version: uniqueId("version"),
      contentHash: "hash",
      projectId: environment.projectId,
      environmentId: environment.id,
      status,
      createdAt: new Date(createdAt),
    },
  });
  return shortCode;
}

const now = new Date("2026-11-20T12:00:00Z");

async function activityDays(prisma: PrismaClient, environment: Environment, timeZone: string) {
  const activity = await deploymentActivityByDay(prisma, schema, {
    environmentId: environment.id,
    timeZone,
    now,
  });
  return activity.days;
}

describe("deploymentActivityByDay", () => {
  // Catches: another environment's deploys in the grid, a deploy that is still building or was
  // canceled counted as live, and a deploy that went live counted as failed.
  postgresTest("counts the environment's deploys per day by outcome", async ({ prisma }) => {
    const environment = await createEnvironment(prisma);
    const other = await createEnvironment(prisma);
    await createDeployment(prisma, environment, "2026-11-18T09:00:00Z");
    await createDeployment(prisma, environment, "2026-11-18T10:00:00Z");
    await createDeployment(prisma, environment, "2026-11-18T11:00:00Z", "FAILED");
    await createDeployment(prisma, environment, "2026-11-18T12:00:00Z", "TIMED_OUT");
    await createDeployment(prisma, environment, "2026-11-18T13:00:00Z", "BUILDING");
    await createDeployment(prisma, environment, "2026-11-18T14:00:00Z", "CANCELED");
    await createDeployment(prisma, environment, "2026-11-19T09:00:00Z");
    await createDeployment(prisma, environment, "2026-11-20T09:00:00Z", "FAILED");
    await createDeployment(prisma, other, "2026-11-18T09:00:00Z");
    await createDeployment(prisma, other, "2026-11-17T09:00:00Z", "FAILED");

    expect(await activityDays(prisma, environment, "UTC")).toEqual([
      { day: "2026-11-18", total: 6, deployed: 2, failed: 2 },
      { day: "2026-11-19", total: 1, deployed: 1, failed: 0 },
      { day: "2026-11-20", total: 1, deployed: 0, failed: 1 },
    ]);
  });

  // Catches: days cut at UTC midnight for a viewer in another time zone.
  postgresTest("puts a deploy on the viewer's calendar day", async ({ prisma }) => {
    const environment = await createEnvironment(prisma);
    await createDeployment(prisma, environment, "2026-11-19T23:30:00Z");
    await createDeployment(prisma, environment, "2026-11-20T02:00:00Z");

    const days = (timeZone: string) => activityDays(prisma, environment, timeZone);

    expect(await days("UTC")).toEqual([
      { day: "2026-11-19", total: 1, deployed: 1, failed: 0 },
      { day: "2026-11-20", total: 1, deployed: 1, failed: 0 },
    ]);
    expect(await days("Asia/Tokyo")).toEqual([
      { day: "2026-11-20", total: 2, deployed: 2, failed: 0 },
    ]);
    expect(await days("America/Los_Angeles")).toEqual([
      { day: "2026-11-19", total: 2, deployed: 2, failed: 0 },
    ]);
  });

  // Catches: the viewer's time zone name handed to Postgres, which doesn't know every name a
  // browser reports ("Asia/Calcutta" is Chrome's name for India, and an error in a Postgres that
  // uses the system's zone data), or reads one differently ("+05:30" is west of UTC to Postgres).
  postgresTest("works for zone names Postgres doesn't share", async ({ prisma }) => {
    const environment = await createEnvironment(prisma);
    // 23:45 and 00:15 on Nov 19 and 20 in India (UTC+5:30).
    await createDeployment(prisma, environment, "2026-11-19T18:15:00Z");
    await createDeployment(prisma, environment, "2026-11-19T18:45:00Z", "FAILED");

    const expected = [
      { day: "2026-11-19", total: 1, deployed: 1, failed: 0 },
      { day: "2026-11-20", total: 1, deployed: 0, failed: 1 },
    ];
    for (const timeZone of ["Asia/Kolkata", "Asia/Calcutta", "+05:30"]) {
      expect(await activityDays(prisma, environment, timeZone)).toEqual(expected);

      const onTheTwentieth = await deploymentsOnDay(prisma, schema, {
        environmentId: environment.id,
        day: "2026-11-20",
        timeZone,
      });
      expect(onTheTwentieth.map((deployment) => deployment.status)).toEqual(["FAILED"]);
    }
  });

  postgresTest("says which day today is for the viewer", async ({ prisma }) => {
    const environment = await createEnvironment(prisma);
    const today = async (timeZone: string) =>
      (
        await deploymentActivityByDay(prisma, schema, {
          environmentId: environment.id,
          timeZone,
          now: new Date("2026-11-20T02:00:00Z"),
        })
      ).today;

    expect(await today("UTC")).toBe("2026-11-20");
    expect(await today("America/Los_Angeles")).toBe("2026-11-19");
  });

  // Catches: the grid's read growing with the environment's whole history.
  postgresTest("reads no further back than the grid's first week", async ({ prisma }) => {
    const environment = await createEnvironment(prisma);
    await createDeployment(prisma, environment, "2024-06-01T09:00:00Z");
    await createDeployment(prisma, environment, "2025-11-10T09:00:00Z");
    // The first square of a grid that ends on 2026-11-20.
    await createDeployment(prisma, environment, "2025-11-17T00:00:00Z");

    expect(await activityDays(prisma, environment, "UTC")).toEqual([
      { day: "2025-11-17", total: 1, deployed: 1, failed: 0 },
    ]);
  });
});

describe("the day filter", () => {
  const cases = [
    {
      // Daylight saving time ends at 02:00, so the day is 25 hours long.
      name: "a 25-hour day",
      timeZone: "America/New_York",
      days: ["2026-10-31", "2026-11-01", "2026-11-02"],
      before: "2026-11-01T03:59:59Z",
      first: "2026-11-01T04:00:00Z",
      last: "2026-11-02T04:59:59Z",
      after: "2026-11-02T05:00:00Z",
    },
    {
      // Cuba's clocks go back from 01:00 to 00:00, so midnight happens twice. The day starts at
      // the first one.
      name: "a day whose midnight happens twice",
      timeZone: "America/Havana",
      days: ["2026-10-31", "2026-11-01", "2026-11-02"],
      before: "2026-11-01T03:59:59Z",
      first: "2026-11-01T04:30:00Z",
      last: "2026-11-01T05:30:00Z",
      after: "2026-11-02T05:00:00Z",
    },
    {
      // Cuba's clocks go forward from 00:00 to 01:00, so the day has no midnight.
      name: "a day with no midnight",
      timeZone: "America/Havana",
      days: ["2026-03-07", "2026-03-08", "2026-03-09"],
      before: "2026-03-08T04:59:59Z",
      first: "2026-03-08T05:00:00Z",
      last: "2026-03-09T03:59:59Z",
      after: "2026-03-09T04:00:00Z",
    },
  ];

  for (const { name, timeZone, days, before, first, last, after } of cases) {
    // Catches: a click on a square listing a different set of deploys than the square counted.
    postgresTest(`covers the same local day the grid counted: ${name}`, async ({ prisma }) => {
      const environment = await createEnvironment(prisma);
      const other = await createEnvironment(prisma);
      await createDeployment(prisma, environment, before);
      const firstCode = await createDeployment(prisma, environment, first);
      const lastCode = await createDeployment(prisma, environment, last, "FAILED");
      await createDeployment(prisma, environment, after);
      await createDeployment(prisma, other, first);

      // The clause the deployments list adds for `?day=`.
      const listed = await prisma.$queryRaw<{ shortCode: string }[]>`
        SELECT wd."shortCode" FROM "WorkerDeployment" AS wd
        WHERE wd."environmentId" = ${environment.id} AND ${deploymentDaySql(days[1], timeZone)}
        ORDER BY wd."createdAt"`;
      expect(listed.map((row) => row.shortCode)).toEqual([firstCode, lastCode]);

      expect(await activityDays(prisma, environment, timeZone)).toEqual([
        { day: days[0], total: 1, deployed: 1, failed: 0 },
        { day: days[1], total: 2, deployed: 1, failed: 1 },
        { day: days[2], total: 1, deployed: 1, failed: 0 },
      ]);
    });
  }

  // Catches: the hover card showing another environment's deploys, or every deploy of a busy day.
  postgresTest("lists a day's deploys newest first, up to the limit", async ({ prisma }) => {
    const environment = await createEnvironment(prisma);
    const other = await createEnvironment(prisma);
    await createDeployment(prisma, environment, "2026-11-18T09:00:00Z");
    const second = await createDeployment(prisma, environment, "2026-11-18T10:00:00Z", "FAILED");
    const third = await createDeployment(prisma, environment, "2026-11-18T11:00:00Z");
    await createDeployment(prisma, environment, "2026-11-19T00:00:00Z");
    await createDeployment(prisma, other, "2026-11-18T12:00:00Z");

    const deployments = await deploymentsOnDay(prisma, schema, {
      environmentId: environment.id,
      day: "2026-11-18",
      timeZone: "UTC",
      limit: 2,
    });

    expect(deployments.map((deployment) => [deployment.shortCode, deployment.status])).toEqual([
      [third, "DEPLOYED"],
      [second, "FAILED"],
    ]);
  });
});

describe("safeTimeZone", () => {
  it("falls back to UTC for a zone the runtime doesn't know", () => {
    expect(safeTimeZone("Europe/London")).toBe("Europe/London");
    expect(safeTimeZone("Mars/Olympus_Mons")).toBe("UTC");
    expect(safeTimeZone("")).toBe("UTC");
    expect(safeTimeZone(undefined)).toBe("UTC");
  });
});
