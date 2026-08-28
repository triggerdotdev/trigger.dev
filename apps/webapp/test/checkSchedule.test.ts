import { containerTest } from "@internal/testcontainers";
import { boundedIn, type PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";
import { resolveProjectScopedEnvironments } from "~/v3/services/resolveProjectScopedEnvironments";

vi.setConfig({ testTimeout: 60_000 });

async function seedProjectWithEnv(prisma: PrismaClient, slugBase: string) {
  const slug = `${slugBase}_${Math.random().toString(36).slice(2, 10)}`;
  const organization = await prisma.organization.create({ data: { title: slug, slug } });
  const project = await prisma.project.create({
    data: { name: slug, slug, organizationId: organization.id, externalRef: slug },
  });
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      slug: `${slug}-prod`,
      type: "PRODUCTION",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_prod_${slug}`,
      pkApiKey: `pk_prod_${slug}`,
      shortcode: slug.slice(0, 6),
    },
  });
  return { organization, project, environment };
}

async function seedBranchEnv(
  prisma: PrismaClient,
  project: { id: string; organizationId: string },
  slugBase: string,
  { archived }: { archived: boolean }
) {
  const slug = `${slugBase}_${Math.random().toString(36).slice(2, 10)}`;
  return prisma.runtimeEnvironment.create({
    data: {
      slug: `${slug}-branch`,
      type: "PREVIEW",
      branchName: slug,
      projectId: project.id,
      organizationId: project.organizationId,
      apiKey: `tr_preview_${slug}`,
      pkApiKey: `pk_preview_${slug}`,
      shortcode: Math.random().toString(36).slice(2, 10),
      archivedAt: archived ? new Date() : null,
    },
  });
}

function projectEnvironments(prisma: PrismaClient, projectId: string) {
  return prisma.runtimeEnvironment.findMany({ where: { projectId }, select: { id: true } });
}

function loadScopedEnvironments(prisma: PrismaClient, projectId: string, environmentIds: string[]) {
  return prisma.project
    .findFirst({
      where: { id: projectId },
      select: {
        organizationId: true,
        environments: {
          where: { id: { in: boundedIn(environmentIds) } },
          select: { id: true, type: true, archivedAt: true },
        },
      },
    })
    .then((project) => project?.environments ?? []);
}

describe("resolveProjectScopedEnvironments (schedule env scoping)", () => {
  containerTest("rejects an environment id that belongs to another project", async ({ prisma }) => {
    const a = await seedProjectWithEnv(prisma, "orga");
    const b = await seedProjectWithEnv(prisma, "orgb");

    const result = resolveProjectScopedEnvironments(
      [a.environment.id, b.environment.id],
      await projectEnvironments(prisma, a.project.id)
    );

    expect(result.kind).toBe("foreign");
    expect(result).toMatchObject({ foreignEnvironmentId: b.environment.id });
  });

  containerTest("accepts environment ids that belong to the project", async ({ prisma }) => {
    const a = await seedProjectWithEnv(prisma, "orga");

    const result = resolveProjectScopedEnvironments(
      [a.environment.id],
      await projectEnvironments(prisma, a.project.id)
    );

    expect(result.kind).toBe("ok");
  });
});

describe("CheckScheduleService bounded environments load", () => {
  containerTest(
    "loads only the requested environments, not every project environment",
    async ({ prisma }) => {
      const a = await seedProjectWithEnv(prisma, "orga");
      for (let i = 0; i < 8; i++) {
        await seedBranchEnv(prisma, a.project, `branch${i}`, { archived: true });
      }
      await seedBranchEnv(prisma, a.project, "active", { archived: false });

      const all = await projectEnvironments(prisma, a.project.id);
      expect(all.length).toBe(10);

      const scoped = await loadScopedEnvironments(prisma, a.project.id, [a.environment.id]);
      expect(scoped.length).toBe(1);
      expect(scoped[0]?.id).toBe(a.environment.id);

      const result = resolveProjectScopedEnvironments([a.environment.id], scoped);
      expect(result.kind).toBe("ok");
    }
  );

  containerTest(
    "still rejects a foreign environment id when the load is bounded",
    async ({ prisma }) => {
      const a = await seedProjectWithEnv(prisma, "orga");
      const b = await seedProjectWithEnv(prisma, "orgb");
      await seedBranchEnv(prisma, a.project, "branch", { archived: true });

      const scoped = await loadScopedEnvironments(prisma, a.project.id, [
        a.environment.id,
        b.environment.id,
      ]);
      expect(scoped.length).toBe(1);

      const result = resolveProjectScopedEnvironments([a.environment.id, b.environment.id], scoped);
      expect(result.kind).toBe("foreign");
      expect(result).toMatchObject({ foreignEnvironmentId: b.environment.id });
    }
  );

  containerTest(
    "still surfaces an archived branch env when it is the requested one",
    async ({ prisma }) => {
      const a = await seedProjectWithEnv(prisma, "orga");
      const archivedBranch = await seedBranchEnv(prisma, a.project, "branch", { archived: true });

      const scoped = await loadScopedEnvironments(prisma, a.project.id, [archivedBranch.id]);
      expect(scoped.length).toBe(1);

      const result = resolveProjectScopedEnvironments([archivedBranch.id], scoped);
      expect(result.kind).toBe("ok");
      expect(result.kind === "ok" && result.environments.some((env) => env.archivedAt)).toBe(true);
    }
  );
});
