import { containerTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";
import { webhookEndpointLookup } from "~/v3/webhookEndpointLookup";

vi.setConfig({ testTimeout: 60_000 });

async function seedEnvironment(prisma: PrismaClient) {
  const slug = `wel_${Math.random().toString(36).slice(2, 10)}`;
  const organization = await prisma.organization.create({ data: { title: slug, slug } });
  const project = await prisma.project.create({
    data: { name: slug, slug, organizationId: organization.id, externalRef: slug },
  });
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      slug: "prod",
      type: "PRODUCTION",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_prod_${slug}`,
      pkApiKey: `pk_prod_${slug}`,
      shortcode: `p${slug.slice(0, 5)}`,
    },
  });
  return { organizationId: organization.id, projectId: project.id, environmentId: environment.id };
}

async function seedEndpoint(
  prisma: PrismaClient,
  env: { organizationId: string; projectId: string; environmentId: string },
  declaredId: string,
  tenantId = ""
) {
  const suffix = Math.random().toString(36).slice(2, 10);
  return prisma.webhookEndpoint.create({
    data: {
      friendlyId: `wh_${suffix}`,
      opaqueId: `op_${suffix}${Math.random().toString(36).slice(2, 10)}`,
      organizationId: env.organizationId,
      projectId: env.projectId,
      runtimeEnvironmentId: env.environmentId,
      environmentType: "PRODUCTION",
      source: "stripe",
      declaredId,
      endpointTenantId: tenantId,
      routingTargets: [],
      verifierArtifact: { kind: "bundle", bundleUrl: "https://example.test/v.js", hash: "h" },
      status: "ACTIVE",
    },
  });
}

describe("webhookEndpointLookup", () => {
  containerTest(
    "finds an endpoint by its declared id or its wh_ id, only in its own environment",
    async ({ prisma }) => {
      const env = await seedEnvironment(prisma);
      const otherEnv = await seedEnvironment(prisma);
      const declared = await seedEndpoint(prisma, env, "payments");
      const tenantInstance = await seedEndpoint(prisma, env, "payments", "tenant_1");
      const elsewhere = await seedEndpoint(prisma, otherEnv, "payments");

      const find = (environmentId: string, endpointId: string) =>
        prisma.webhookEndpoint.findFirst({
          where: webhookEndpointLookup(environmentId, endpointId),
        });

      expect((await find(env.environmentId, "payments"))?.id).toBe(declared.id);
      expect((await find(env.environmentId, declared.friendlyId))?.id).toBe(declared.id);
      expect((await find(env.environmentId, tenantInstance.friendlyId))?.id).toBe(
        tenantInstance.id
      );
      expect(await find(env.environmentId, elsewhere.friendlyId)).toBeNull();
      expect((await find(otherEnv.environmentId, "payments"))?.id).toBe(elsewhere.id);
      expect(await find(env.environmentId, "refunds")).toBeNull();

      await seedEndpoint(prisma, env, "wh_prefixed");
      expect(await find(env.environmentId, "wh_prefixed")).toBeNull();
    }
  );
});
