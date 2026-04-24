import type { PrismaClient } from "@trigger.dev/database";
import { randomBytes } from "crypto";

function randomHex(len = 12): string {
  return randomBytes(Math.ceil(len / 2)).toString("hex").slice(0, len);
}

export async function seedTestEnvironment(prisma: PrismaClient) {
  const suffix = randomHex(8);
  const apiKey = `tr_dev_${randomHex(24)}`;
  const pkApiKey = `pk_dev_${randomHex(24)}`;

  const t0 = Date.now();
  process.stderr.write(`[seed] creating organization (${suffix})...\n`);

  const organization = await prisma.organization.create({
    data: {
      title: `e2e-test-org-${suffix}`,
      slug: `e2e-org-${suffix}`,
      v3Enabled: true,
    },
  });
  process.stderr.write(`[seed] organization created in ${Date.now() - t0}ms\n`);

  const project = await prisma.project.create({
    data: {
      name: `e2e-test-project-${suffix}`,
      slug: `e2e-proj-${suffix}`,
      externalRef: `proj_${suffix}`,
      organizationId: organization.id,
      engine: "V2",
    },
  });
  process.stderr.write(`[seed] project created in ${Date.now() - t0}ms\n`);

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
  process.stderr.write(`[seed] environment created in ${Date.now() - t0}ms\n`);

  return { organization, project, environment, apiKey };
}
