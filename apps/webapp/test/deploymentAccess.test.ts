import { randomUUID } from "node:crypto";
import { postgresTest } from "@internal/testcontainers";
import type { DeploymentAccessController, DeploymentIntegrationAccess } from "@trigger.dev/plugins";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClientOrTransaction } from "~/db.server";
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

  // Catches: the global computeOnlyDeploys switch not reaching the plugin, or a cold flag snapshot
  // reading as on and letting an otherwise denied organization deploy.
  it("sends the computeOnlyDeploys switch with each check, off when the snapshot is cold", async () => {
    const seen: boolean[] = [];
    const recording = controllerWith({
      async checkDeploy(sent) {
        seen.push(sent.computeOnlyDeploys);
        return { allowed: false, kind: "denied" };
      },
    });
    await checkDeployAccess(check, { controller: recording, computeOnlyDeploys: true });
    await checkDeployAccess(check, { controller: recording });
    expect(seen).toEqual([true, false]);
  });

  // Catches: a database error while writing the computeOnly flag refusing the deploy with the
  // permanent "not available" message instead of asking for a retry, or letting it through.
  it("refuses with a retry message when the computeOnly flag can't be written", async () => {
    const microvm = controllerWith({
      async checkDeploy() {
        return { allowed: true, placement: "microvm" };
      },
    });
    const broken = {
      $executeRaw: async () => {
        throw new Error("connection reset");
      },
    } as unknown as PrismaClientOrTransaction;
    expect(
      await checkDeployAccess(check, {
        controller: microvm,
        client: broken,
        organizationFeatureFlags: {},
      })
    ).toEqual({
      allowed: false,
      kind: "denied",
      message: "We couldn't prepare this deploy. Try deploying again.",
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

// Catches: a stage other than initialize rewriting `computeOnly`, e.g. register_worker's plain
// allow clearing it from an org already on compute so its runs move to containers.
postgresTest(
  "only an allowed initialize decision syncs the computeOnly flag",
  async ({ prisma }) => {
    const org = await prisma.organization.create({
      data: { title: "Org", slug: randomUUID(), featureFlags: {} },
    });
    const flags = async () =>
      (await prisma.organization.findUniqueOrThrow({ where: { id: org.id } })).featureFlags;
    const microvm = controllerWith({
      async checkDeploy() {
        return { allowed: true, placement: "microvm" };
      },
    });
    const plainAllow = controllerWith();
    const deny = controllerWith({
      async checkDeploy() {
        return { allowed: false, kind: "denied" };
      },
    });
    const at = (stage: "preflight" | "initialize" | "register_worker") => ({
      stage,
      organizationId: org.id,
    });

    await checkDeployAccess(at("preflight"), { client: prisma, controller: microvm });
    expect(await flags()).toEqual({});
    await checkDeployAccess(at("initialize"), { client: prisma, controller: microvm });
    expect(await flags()).toEqual({ computeOnly: true });

    await checkDeployAccess(at("register_worker"), { client: prisma, controller: plainAllow });
    await checkDeployAccess(at("initialize"), { client: prisma, controller: deny });
    expect(await flags()).toEqual({ computeOnly: true });

    await checkDeployAccess(at("initialize"), { client: prisma, controller: plainAllow });
    expect(await flags()).toEqual({});
  }
);

// Catches: initialize sending an UPDATE to the primary on every plain deploy, though the org's
// loaded flags already show there is no computeOnly to clear.
postgresTest(
  "initialize writes computeOnly except for a plain deploy of an org without the flag",
  async ({ prisma }) => {
    const org = await prisma.organization.create({
      data: { title: "Org", slug: randomUUID(), featureFlags: {} },
    });
    let writes = 0;
    const client = new Proxy(prisma, {
      get(target, prop, receiver) {
        if (prop !== "$executeRaw") return Reflect.get(target, prop, receiver);
        return (...args: Parameters<typeof prisma.$executeRaw>) => {
          writes++;
          return target.$executeRaw(...args);
        };
      },
    });
    const loaded = async () =>
      (await prisma.organization.findUniqueOrThrow({ where: { id: org.id } })).featureFlags;
    const initialize = async (controller: DeploymentAccessController) =>
      checkDeployAccess(
        { stage: "initialize", organizationId: org.id },
        { client, controller, organizationFeatureFlags: await loaded() }
      );
    const microvm = controllerWith({
      async checkDeploy() {
        return { allowed: true, placement: "microvm" };
      },
    });

    await initialize(controllerWith());
    expect(writes).toBe(0);

    await initialize(microvm);
    expect(writes).toBe(1);
    expect(await loaded()).toEqual({ computeOnly: true });
    // A compute-only deploy always sends its statement; the WHERE leaves the row as it is.
    await initialize(microvm);
    expect(writes).toBe(2);

    await initialize(controllerWith());
    expect(writes).toBe(3);
    expect(await loaded()).toEqual({});

    // Catches: a stale replica read that still shows computeOnly (cleared on the primary moments
    // before) skipping the write, so the org deploys without the flag.
    await checkDeployAccess(
      { stage: "initialize", organizationId: org.id },
      { client, controller: microvm, organizationFeatureFlags: { computeOnly: true } }
    );
    expect(await loaded()).toEqual({ computeOnly: true });
  }
);
