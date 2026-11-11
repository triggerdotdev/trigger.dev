import { randomUUID } from "node:crypto";
import { postgresTest } from "@internal/testcontainers";
import type { DeploymentAccessController, DeploymentIntegrationAccess } from "@trigger.dev/plugins";
import { describe, expect, it, vi } from "vitest";
import {
  checkDeployAccess,
  integrationAccess,
  resolveIntegrationAccess,
} from "~/v3/deploymentAccess.server";

vi.setConfig({ testTimeout: 60_000 });

function controllerWith(
  overrides: Partial<DeploymentAccessController> = {}
): DeploymentAccessController {
  return {
    async checkDeploy() {
      return { allowed: true };
    },
    async integrationAccess() {
      return { github: true, vercel: true };
    },
    ...overrides,
  };
}

const failing = controllerWith({
  async checkDeploy() {
    throw new Error("plugin down");
  },
  async integrationAccess() {
    throw new Error("plugin down");
  },
});

describe("checkDeployAccess", () => {
  const check = { stage: "initialize" as const, organizationId: "org_1" };

  // Catches: self-hosted instances (no plugin) having their deploys refused.
  it("allows everything without a plugin", async () => {
    expect(await checkDeployAccess(check, { controller: null })).toEqual({ allowed: true });
  });

  // Catches: a plugin error failing open and letting a deploy through.
  it("denies when the plugin throws", async () => {
    expect(await checkDeployAccess(check, { controller: failing })).toEqual({
      allowed: false,
      kind: "denied",
    });
  });
});

describe("integrationAccess", () => {
  // Catches: self-hosted instances losing GitHub and Vercel, or a plugin error unlocking them.
  it("allows both integrations without a plugin and refuses both when the plugin throws", async () => {
    expect(await integrationAccess("org_1", { controller: null })).toEqual({
      github: true,
      vercel: true,
    });
    expect(await integrationAccess("org_1", { controller: failing })).toEqual({
      github: false,
      vercel: false,
    });
  });
});

// Catches: an org that can't start new connections also losing the panel for a connection it
// already has, so it can't inspect or disconnect it.
postgresTest(
  "an org that can't connect integrations keeps the ones it already has so it can disconnect them",
  async ({ prisma }) => {
    const org = await prisma.organization.create({
      data: { title: "Org", slug: randomUUID() },
    });
    const createProject = () =>
      prisma.project.create({
        data: {
          name: "Project",
          slug: randomUUID(),
          externalRef: `proj_${randomUUID()}`,
          organizationId: org.id,
        },
      });
    const empty = await createProject();
    const connected = await createProject();

    const installation = await prisma.githubAppInstallation.create({
      data: {
        appInstallationId: BigInt(Math.floor(Math.random() * 1e9)),
        targetId: 1n,
        targetType: "Organization",
        accountHandle: "acme",
        repositorySelection: "SELECTED",
        organizationId: org.id,
      },
    });
    const repository = await prisma.githubRepository.create({
      data: {
        githubId: 1n,
        name: "app",
        fullName: "acme/app",
        htmlUrl: "https://github.com/acme/app",
        private: true,
        defaultBranch: "main",
        installationId: installation.id,
      },
    });
    await prisma.connectedGithubRepository.create({
      data: { projectId: connected.id, repositoryId: repository.id, branchTracking: {} },
    });
    const token = await prisma.secretReference.create({ data: { key: randomUUID() } });
    const vercel = await prisma.organizationIntegration.create({
      data: {
        friendlyId: randomUUID(),
        service: "VERCEL",
        integrationData: {},
        tokenReferenceId: token.id,
        organizationId: org.id,
      },
    });
    await prisma.organizationProjectIntegration.create({
      data: {
        organizationIntegrationId: vercel.id,
        projectId: connected.id,
        externalEntityId: "prj_vercel",
        integrationData: {},
      },
    });

    const access = (projectId: string, allowed: DeploymentIntegrationAccess) =>
      resolveIntegrationAccess(org.id, projectId, {
        client: prisma,
        controller: controllerWith({ integrationAccess: async () => allowed }),
      });
    const none = { github: false, vercel: false };

    expect(await access(empty.id, { github: true, vercel: true })).toEqual({
      github: true,
      vercel: true,
    });
    expect(await access(empty.id, none)).toEqual(none);
    expect(await access(connected.id, none)).toEqual({ github: true, vercel: true });
    expect(await access(empty.id, { github: true, vercel: false })).toEqual({
      github: true,
      vercel: false,
    });

    await prisma.githubAppInstallation.update({
      where: { id: installation.id },
      data: { deletedAt: new Date() },
    });
    await prisma.organizationProjectIntegration.updateMany({
      where: { projectId: connected.id },
      data: { deletedAt: new Date() },
    });
    expect(await access(connected.id, none)).toEqual(none);
  }
);
