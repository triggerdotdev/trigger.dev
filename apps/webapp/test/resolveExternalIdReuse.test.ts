import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient, WorkerDeploymentStatus } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";
import { resolveExternalIdReuse } from "~/v3/services/initializeDeployment/resolveExternalIdReuse.server";

vi.setConfig({ testTimeout: 30_000 });

async function seedEnvironment(prisma: PrismaClient) {
  const slug = `s${Math.random().toString(36).slice(2, 10)}`;
  const organization = await prisma.organization.create({
    data: { title: slug, slug },
  });

  const project = await prisma.project.create({
    data: {
      name: slug,
      slug,
      organizationId: organization.id,
      externalRef: slug,
    },
  });

  const environment = await prisma.runtimeEnvironment.create({
    data: {
      slug,
      type: "PRODUCTION",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: slug,
      pkApiKey: slug,
      shortcode: slug,
    },
  });

  return { organization, project, environment };
}

async function seedDeployment(
  prisma: PrismaClient,
  args: {
    projectId: string;
    environmentId: string;
    version: string;
    status: WorkerDeploymentStatus;
    externalId?: string;
  }
) {
  const unique = Math.random().toString(36).slice(2, 10);

  return prisma.workerDeployment.create({
    data: {
      friendlyId: `deployment_${unique}`,
      shortCode: `short_${unique}`,
      contentHash: `hash_${unique}`,
      imageReference: `registry.example/image:${args.version}`,
      projectId: args.projectId,
      environmentId: args.environmentId,
      version: args.version,
      status: args.status,
      externalId: args.externalId,
    },
  });
}

const IN_FLIGHT_STATUSES: WorkerDeploymentStatus[] = [
  "PENDING",
  "BUILDING",
  "INSTALLING",
  "DEPLOYING",
];

const FINAL_NON_DEPLOYED_STATUSES: WorkerDeploymentStatus[] = ["FAILED", "CANCELED", "TIMED_OUT"];

describe("resolveExternalIdReuse", () => {
  postgresTest("builds when no external id is passed", async ({ prisma }) => {
    const { project, environment } = await seedEnvironment(prisma);

    await seedDeployment(prisma, {
      projectId: project.id,
      environmentId: environment.id,
      version: "20260101.1",
      status: "DEPLOYED",
      externalId: "abc123",
    });

    const result = await resolveExternalIdReuse({
      prisma,
      environmentId: environment.id,
      externalId: undefined,
      force: false,
    });

    expect(result.action).toBe("build");
  });

  postgresTest("builds when the external id has never been seen", async ({ prisma }) => {
    const { environment } = await seedEnvironment(prisma);

    const result = await resolveExternalIdReuse({
      prisma,
      environmentId: environment.id,
      externalId: "brand-new-id",
      force: false,
    });

    expect(result.action).toBe("build");
  });

  postgresTest(
    "short-circuits to the highest deployed version when the id is already deployed",
    async ({ prisma }) => {
      const { project, environment } = await seedEnvironment(prisma);
      const externalId = "abc123";

      for (const version of ["20260101.1", "20260101.2", "20260101.3"]) {
        await seedDeployment(prisma, {
          projectId: project.id,
          environmentId: environment.id,
          version,
          status: "DEPLOYED",
          externalId,
        });
      }

      const result = await resolveExternalIdReuse({
        prisma,
        environmentId: environment.id,
        externalId,
        force: false,
      });

      expect(result.action).toBe("short-circuit");
      if (result.action === "short-circuit") {
        expect(result.deployment.version).toBe("20260101.3");
      }
    }
  );

  for (const status of FINAL_NON_DEPLOYED_STATUSES) {
    postgresTest(`builds when the id only holds a ${status} deployment`, async ({ prisma }) => {
      const { project, environment } = await seedEnvironment(prisma);
      const externalId = "abc123";

      await seedDeployment(prisma, {
        projectId: project.id,
        environmentId: environment.id,
        version: "20260101.1",
        status,
        externalId,
      });

      const result = await resolveExternalIdReuse({
        prisma,
        environmentId: environment.id,
        externalId,
        force: false,
      });

      expect(result.action).toBe("build");
    });
  }

  for (const status of IN_FLIGHT_STATUSES) {
    postgresTest(`rejects when the id holds a ${status} deployment`, async ({ prisma }) => {
      const { project, environment } = await seedEnvironment(prisma);
      const externalId = "abc123";

      await seedDeployment(prisma, {
        projectId: project.id,
        environmentId: environment.id,
        version: "20260101.7",
        status,
        externalId,
      });

      const result = await resolveExternalIdReuse({
        prisma,
        environmentId: environment.id,
        externalId,
        force: false,
      });

      expect(result.action).toBe("reject");
      if (result.action === "reject") {
        expect(result.deployment.version).toBe("20260101.7");
        expect(result.deployment.status).toBe(status);
      }
    });
  }

  postgresTest(
    "rejects when the id holds both an in-flight build and an older deployed version",
    async ({ prisma }) => {
      const { project, environment } = await seedEnvironment(prisma);
      const externalId = "abc123";

      await seedDeployment(prisma, {
        projectId: project.id,
        environmentId: environment.id,
        version: "20260101.1",
        status: "DEPLOYED",
        externalId,
      });
      await seedDeployment(prisma, {
        projectId: project.id,
        environmentId: environment.id,
        version: "20260101.2",
        status: "BUILDING",
        externalId,
      });

      const result = await resolveExternalIdReuse({
        prisma,
        environmentId: environment.id,
        externalId,
        force: false,
      });

      expect(result.action).toBe("reject");
      if (result.action === "reject") {
        expect(result.deployment.version).toBe("20260101.2");
      }
    }
  );

  postgresTest(
    "rejects on an in-flight build even when a higher version is already deployed",
    async ({ prisma }) => {
      const { project, environment } = await seedEnvironment(prisma);
      const externalId = "abc123";

      await seedDeployment(prisma, {
        projectId: project.id,
        environmentId: environment.id,
        version: "20260101.2",
        status: "DEPLOYED",
        externalId,
      });
      await seedDeployment(prisma, {
        projectId: project.id,
        environmentId: environment.id,
        version: "20260101.1",
        status: "BUILDING",
        externalId,
      });

      const result = await resolveExternalIdReuse({
        prisma,
        environmentId: environment.id,
        externalId,
        force: false,
      });

      expect(result.action).toBe("reject");
      if (result.action === "reject") {
        expect(result.deployment.version).toBe("20260101.1");
      }
    }
  );

  postgresTest("builds when force is passed over a deployed id", async ({ prisma }) => {
    const { project, environment } = await seedEnvironment(prisma);
    const externalId = "abc123";

    const existing = await seedDeployment(prisma, {
      projectId: project.id,
      environmentId: environment.id,
      version: "20260101.1",
      status: "DEPLOYED",
      externalId,
    });

    const result = await resolveExternalIdReuse({
      prisma,
      environmentId: environment.id,
      externalId,
      force: true,
    });

    expect(result.action).toBe("build");

    const stillThere = await prisma.workerDeployment.findFirst({ where: { id: existing.id } });
    expect(stillThere?.status).toBe("DEPLOYED");
  });

  for (const status of IN_FLIGHT_STATUSES) {
    postgresTest(
      `force cancels a ${status} deployment rather than racing it`,
      async ({ prisma }) => {
        const { project, environment } = await seedEnvironment(prisma);
        const externalId = "abc123";

        const inFlight = await seedDeployment(prisma, {
          projectId: project.id,
          environmentId: environment.id,
          version: "20260101.1",
          status,
          externalId,
        });

        const result = await resolveExternalIdReuse({
          prisma,
          environmentId: environment.id,
          externalId,
          force: true,
        });

        expect(result.action).toBe("cancel-then-build");
        if (result.action !== "cancel-then-build") return;

        expect(result.externalId).toBe(externalId);
        expect(result.deployments.map((deployment) => deployment.id)).toEqual([inFlight.id]);
      }
    );
  }

  for (const status of FINAL_NON_DEPLOYED_STATUSES) {
    postgresTest(`force has nothing to cancel over a ${status} deployment`, async ({ prisma }) => {
      const { project, environment } = await seedEnvironment(prisma);
      const externalId = "abc123";

      await seedDeployment(prisma, {
        projectId: project.id,
        environmentId: environment.id,
        version: "20260101.1",
        status,
        externalId,
      });

      const result = await resolveExternalIdReuse({
        prisma,
        environmentId: environment.id,
        externalId,
        force: true,
      });

      expect(result.action).toBe("build");
    });
  }

  postgresTest(
    "force cancels every in-flight deployment, highest version first",
    async ({ prisma }) => {
      const { project, environment } = await seedEnvironment(prisma);
      const externalId = "abc123";

      const middle = await seedDeployment(prisma, {
        projectId: project.id,
        environmentId: environment.id,
        version: "20260101.9",
        status: "BUILDING",
        externalId,
      });

      const highest = await seedDeployment(prisma, {
        projectId: project.id,
        environmentId: environment.id,
        version: "20260101.10",
        status: "PENDING",
        externalId,
      });

      const lowest = await seedDeployment(prisma, {
        projectId: project.id,
        environmentId: environment.id,
        version: "20260101.2",
        status: "DEPLOYING",
        externalId,
      });

      const result = await resolveExternalIdReuse({
        prisma,
        environmentId: environment.id,
        externalId,
        force: true,
      });

      expect(result.action).toBe("cancel-then-build");
      if (result.action !== "cancel-then-build") return;

      expect(result.deployments.map((deployment) => deployment.id)).toEqual([
        highest.id,
        middle.id,
        lowest.id,
      ]);
    }
  );

  postgresTest("force lists only the in-flight rows, never the final ones", async ({ prisma }) => {
    const { project, environment } = await seedEnvironment(prisma);
    const externalId = "abc123";

    await seedDeployment(prisma, {
      projectId: project.id,
      environmentId: environment.id,
      version: "20260101.1",
      status: "DEPLOYED",
      externalId,
    });

    await seedDeployment(prisma, {
      projectId: project.id,
      environmentId: environment.id,
      version: "20260101.2",
      status: "FAILED",
      externalId,
    });

    const building = await seedDeployment(prisma, {
      projectId: project.id,
      environmentId: environment.id,
      version: "20260101.3",
      status: "BUILDING",
      externalId,
    });

    const result = await resolveExternalIdReuse({
      prisma,
      environmentId: environment.id,
      externalId,
      force: true,
    });

    expect(result.action).toBe("cancel-then-build");
    if (result.action !== "cancel-then-build") return;

    expect(result.deployments.map((deployment) => deployment.id)).toEqual([building.id]);
  });

  postgresTest("force never reaches into another environment", async ({ prisma }) => {
    const { project, environment } = await seedEnvironment(prisma);
    const other = await seedEnvironment(prisma);
    const externalId = "abc123";

    await seedDeployment(prisma, {
      projectId: other.project.id,
      environmentId: other.environment.id,
      version: "20260101.1",
      status: "BUILDING",
      externalId,
    });

    const result = await resolveExternalIdReuse({
      prisma,
      environmentId: environment.id,
      externalId,
      force: true,
    });

    expect(result.action).toBe("build");
    expect(project.id).not.toBe(other.project.id);
  });

  postgresTest(
    "picks the highest version, not the newest row, when versions are seeded out of creation order",
    async ({ prisma }) => {
      const { project, environment } = await seedEnvironment(prisma);
      const externalId = "abc123";

      await seedDeployment(prisma, {
        projectId: project.id,
        environmentId: environment.id,
        version: "20260101.10",
        status: "DEPLOYED",
        externalId,
      });
      await seedDeployment(prisma, {
        projectId: project.id,
        environmentId: environment.id,
        version: "20260101.9",
        status: "DEPLOYED",
        externalId,
      });

      const result = await resolveExternalIdReuse({
        prisma,
        environmentId: environment.id,
        externalId,
        force: false,
      });

      expect(result.action).toBe("short-circuit");
      if (result.action === "short-circuit") {
        expect(result.deployment.version).toBe("20260101.10");
      }
    }
  );

  postgresTest("isolates the same external id across environments", async ({ prisma }) => {
    const first = await seedEnvironment(prisma);
    const second = await seedEnvironment(prisma);
    const externalId = "abc123";

    await seedDeployment(prisma, {
      projectId: first.project.id,
      environmentId: first.environment.id,
      version: "20260101.1",
      status: "DEPLOYED",
      externalId,
    });

    const sameEnvironment = await resolveExternalIdReuse({
      prisma,
      environmentId: first.environment.id,
      externalId,
      force: false,
    });
    expect(sameEnvironment.action).toBe("short-circuit");

    const otherEnvironment = await resolveExternalIdReuse({
      prisma,
      environmentId: second.environment.id,
      externalId,
      force: false,
    });
    expect(otherEnvironment.action).toBe("build");
  });
});
