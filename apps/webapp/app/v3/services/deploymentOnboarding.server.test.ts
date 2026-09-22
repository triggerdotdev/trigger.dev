import { randomUUID } from "node:crypto";
import { postgresTest } from "@internal/testcontainers";
import { expect } from "vitest";
import type { PrismaClient } from "~/db.server";
import type { WorkerDeploymentStatus } from "@trigger.dev/database";
import { findOnboardingDeployment } from "./deploymentOnboarding.server";

async function seed(prisma: PrismaClient) {
  const id = randomUUID();
  const org = await prisma.organization.create({ data: { title: "Onboarding", slug: id } });
  const project = await prisma.project.create({
    data: { name: "Tasks", slug: id, externalRef: id, organizationId: org.id, version: "V3" },
  });
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      slug: "prod",
      type: "PRODUCTION",
      apiKey: id,
      pkApiKey: id,
      shortcode: id,
      projectId: project.id,
      organizationId: org.id,
    },
  });
  return { project, environment };
}
async function deploy(
  prisma: PrismaClient,
  env: Awaited<ReturnType<typeof seed>>,
  status: WorkerDeploymentStatus,
  triggeredVia: string | null = "git_integration:github"
) {
  const id = randomUUID();
  return prisma.workerDeployment.create({
    data: {
      friendlyId: id,
      shortCode: id,
      contentHash: id,
      version: id,
      projectId: env.project.id,
      environmentId: env.environment.id,
      status,
      triggeredVia,
    },
  });
}

postgresTest(
  "restores the environment's first GitHub attempt through active and failed states, then exits on success",
  async ({ prisma }) => {
    const subject = await seed(prisma);
    const other = await seed(prisma);
    await deploy(prisma, other, "DEPLOYED");
    const siblingId = randomUUID();
    const sibling = await prisma.runtimeEnvironment.create({
      data: {
        slug: "staging",
        type: "STAGING",
        apiKey: siblingId,
        pkApiKey: siblingId,
        shortcode: siblingId,
        projectId: subject.project.id,
        organizationId: subject.environment.organizationId,
      },
    });
    await deploy(prisma, { project: subject.project, environment: sibling }, "DEPLOYED");
    expect(await findOnboardingDeployment(prisma, subject.environment.id)).toEqual({
      eligible: true,
    });
    const build = await deploy(prisma, subject, "PENDING");
    for (const status of [
      "PENDING",
      "INSTALLING",
      "BUILDING",
      "DEPLOYING",
      "FAILED",
      "CANCELED",
      "TIMED_OUT",
    ] as const) {
      await prisma.workerDeployment.update({ where: { id: build.id }, data: { status } });
      // A fresh invocation has no browser state; other organizations cannot affect it.
      expect(await findOnboardingDeployment(prisma, subject.environment.id)).toEqual({
        eligible: true,
        shortCode: build.shortCode,
      });
    }
    const retry = await deploy(prisma, subject, "BUILDING");
    expect(await findOnboardingDeployment(prisma, subject.environment.id)).toEqual({
      eligible: true,
      shortCode: retry.shortCode,
    });
    await prisma.workerDeployment.update({ where: { id: retry.id }, data: { status: "DEPLOYED" } });
    await deploy(prisma, subject, "FAILED");
    expect(await findOnboardingDeployment(prisma, subject.environment.id)).toEqual({
      eligible: false,
    });
  }
);

postgresTest(
  "preserves established CLI and historical environments even without a successful build",
  async ({ prisma }) => {
    for (const source of [null, "cli", "github_actions"]) {
      const subject = await seed(prisma);
      await deploy(prisma, subject, "FAILED", source);
      await deploy(prisma, subject, "PENDING");
      expect(await findOnboardingDeployment(prisma, subject.environment.id)).toEqual({
        eligible: false,
      });
    }
  }
);
