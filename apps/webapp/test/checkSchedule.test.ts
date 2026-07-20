import { containerTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";
import { resolveProjectScopedEnvironments } from "~/v3/services/resolveProjectScopedEnvironments";

vi.setConfig({ testTimeout: 60_000 });

// Exercises the environment-scoping primitive CheckScheduleService relies on
// (`resolveProjectScopedEnvironments`) with real RuntimeEnvironment rows,
// imported directly to avoid `~/db.server` and its eager global-prisma connect.

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

function projectEnvironments(prisma: PrismaClient, projectId: string) {
  return prisma.runtimeEnvironment.findMany({ where: { projectId }, select: { id: true } });
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
