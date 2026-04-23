import type { PrismaClient } from "@trigger.dev/database";

function randomHex(len = 12): string {
  return Math.random().toString(16).slice(2, 2 + len).padEnd(len, "0");
}

export async function seedTestEnvironment(prisma: PrismaClient) {
  const suffix = randomHex(8);
  const apiKey = `tr_dev_${randomHex(24)}`;
  const pkApiKey = `pk_dev_${randomHex(24)}`;

  const organization = await prisma.organization.create({
    data: {
      title: `e2e-test-org-${suffix}`,
      slug: `e2e-org-${suffix}`,
      v3Enabled: true,
    },
  });

  const project = await prisma.project.create({
    data: {
      name: `e2e-test-project-${suffix}`,
      slug: `e2e-proj-${suffix}`,
      externalRef: `proj_${suffix}`,
      organizationId: organization.id,
      engine: "V2",
    },
  });

  const environment = await prisma.runtimeEnvironment.create({
    data: {
      slug: "dev",
      type: "DEVELOPMENT",
      apiKey,
      pkApiKey,
      shortcode: suffix.slice(0, 4),
      projectId: project.id,
      organizationId: organization.id,
    },
  });

  return { organization, project, environment, apiKey };
}
