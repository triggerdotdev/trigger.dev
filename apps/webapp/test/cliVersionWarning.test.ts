import { containerTest } from "@internal/testcontainers";
import { setupAuthenticatedEnvironment } from "@internal/run-engine/tests";
import type { PrismaClient } from "@trigger.dev/database";
import { expect, it, vi } from "vitest";
import {
  cliVersionWarningFor,
  environmentCliVersionWarning,
} from "~/presenters/v3/cliVersionWarning.server";

vi.setConfig({ testTimeout: 60_000 });

const policy = { minimum: "4.5.20", enforcedFrom: new Date("2099-01-01T00:00:00Z") };
const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

async function deploy(
  prisma: PrismaClient,
  environment: { id: string; projectId: string },
  {
    createdAt,
    cliVersion,
    workerCliVersion,
  }: { createdAt: Date; cliVersion?: string; workerCliVersion?: string }
) {
  const suffix = Math.random().toString(36).slice(2, 10);
  const worker = workerCliVersion
    ? await prisma.backgroundWorker.create({
        data: {
          friendlyId: `worker_${suffix}`,
          contentHash: suffix,
          version: suffix,
          metadata: {},
          cliVersion: workerCliVersion,
          projectId: environment.projectId,
          runtimeEnvironmentId: environment.id,
        },
      })
    : undefined;
  await prisma.workerDeployment.create({
    data: {
      friendlyId: `deployment_${suffix}`,
      shortCode: suffix,
      contentHash: suffix,
      version: suffix,
      status: "DEPLOYED",
      projectId: environment.projectId,
      environmentId: environment.id,
      cliVersion,
      workerId: worker?.id,
      createdAt,
    },
  });
}

// Catches: the banner reading a deploy outside the window or one without a readable version, or
// the higher of the two recorded versions.
containerTest(
  "warns from the latest recent deployment with a known version, using its lower version",
  async ({ prisma }) => {
    const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
    const warning = () =>
      environmentCliVersionWarning(prisma, {
        environmentId: environment.id,
        policy,
        since: daysAgo(30),
      });

    await deploy(prisma, environment, { createdAt: daysAgo(40), cliVersion: "4.5.1" });
    expect(await warning()).toBeUndefined();

    await deploy(prisma, environment, {
      createdAt: daysAgo(2),
      cliVersion: "4.5.25",
      workerCliVersion: "4.5.12",
    });
    await deploy(prisma, environment, { createdAt: daysAgo(1), workerCliVersion: "unknown" });
    await deploy(prisma, environment, { createdAt: daysAgo(0), cliVersion: "not-a-version" });
    expect(await warning()).toMatchObject({ cliVersion: "4.5.12", enforced: false });
  }
);

// Catches: showing the enforcement day itself, the viewer's local date, or "Sept".
it("shows the last supported day in UTC", () => {
  const warning = cliVersionWarningFor(
    { minimum: "4.5.20", enforcedFrom: new Date("2026-10-01T00:30:00+01:00") },
    "4.5.1"
  );
  expect(warning?.lastSupportedDay).toBe("29 Sep 2026");
});

// Catches: an exempt 0.0.0 prerelease on one stage hiding a below-minimum version on the other.
it("warns about either recorded version", () => {
  const policy = { minimum: "4.5.20", enforcedFrom: new Date("2099-01-01T00:00:00Z") };
  expect(cliVersionWarningFor(policy, "0.0.0-prerelease-1", "4.5.1")?.cliVersion).toBe("4.5.1");
});
