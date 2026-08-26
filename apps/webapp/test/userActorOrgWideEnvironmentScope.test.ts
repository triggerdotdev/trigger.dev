/**
 * An org-wide user-actor token exchanges for any environment of its org, only for a member.
 * Membership is checked against a real database: the query, not an ability check, is the floor.
 */

import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { expect, vi } from "vitest";

const ctx = vi.hoisted(() => ({ prisma: undefined as unknown as PrismaClient }));

vi.mock("~/db.server", () => {
  const proxy = new Proxy(
    {},
    { get: (_target, prop) => (ctx.prisma as unknown as Record<string, unknown>)[prop as string] }
  );
  return { prisma: proxy, $replica: proxy, sqlDatabaseSchema: undefined };
});

const { assertUserActorEnvironmentAccess } = await import("~/services/userActorEnvironment.server");

function suffix() {
  return Math.random().toString(36).slice(2, 10);
}

/** An org with two environments, a member user and an outsider. */
async function seedOrg(prisma: PrismaClient) {
  const slug = `orgwide_${suffix()}`;
  const member = await prisma.user.create({
    data: { email: `${slug}-member@example.com`, authenticationMethod: "MAGIC_LINK" },
  });
  const outsider = await prisma.user.create({
    data: { email: `${slug}-outsider@example.com`, authenticationMethod: "MAGIC_LINK" },
  });
  const organization = await prisma.organization.create({ data: { title: slug, slug } });
  await prisma.orgMember.create({
    data: { organizationId: organization.id, userId: member.id, role: "ADMIN" },
  });
  const project = await prisma.project.create({
    data: { name: slug, slug, organizationId: organization.id, externalRef: `proj_${slug}` },
  });
  const environmentFor = (envSlug: string) =>
    prisma.runtimeEnvironment.create({
      data: {
        slug: envSlug,
        type: envSlug === "prod" ? "PRODUCTION" : "STAGING",
        projectId: project.id,
        organizationId: organization.id,
        apiKey: `tr_${envSlug}_${slug}`,
        pkApiKey: `pk_${envSlug}_${slug}`,
        shortcode: `${envSlug}${suffix()}`,
      },
    });

  return {
    member,
    outsider,
    organization,
    envA: await environmentFor("prod"),
    envB: await environmentFor("stg"),
  };
}

async function statusOf(promise: Promise<void>) {
  try {
    await promise;
    return 200;
  } catch (thrown) {
    if (thrown instanceof Response) return thrown.status;
    throw thrown;
  }
}

postgresTest("org-wide user-actor environment scope", async ({ prisma }) => {
  ctx.prisma = prisma;
  const orgA = await seedOrg(prisma);
  const orgB = await seedOrg(prisma);

  // A member exchanges for any environment of its own org, including one the token never named.
  const orgClaims = { userId: orgA.member.id, organizationId: orgA.organization.id };
  await expect(statusOf(assertUserActorEnvironmentAccess(orgClaims, orgA.envA))).resolves.toBe(200);
  await expect(statusOf(assertUserActorEnvironmentAccess(orgClaims, orgA.envB))).resolves.toBe(200);

  // Same org, but the user isn't a member of it.
  const outsiderClaims = { userId: orgB.outsider.id, organizationId: orgA.organization.id };
  await expect(statusOf(assertUserActorEnvironmentAccess(outsiderClaims, orgA.envA))).resolves.toBe(
    403
  );

  // Another organization's environment, even for a member of the claimed org.
  await expect(statusOf(assertUserActorEnvironmentAccess(orgClaims, orgB.envA))).resolves.toBe(403);

  // The environment-claim path is unchanged: its own environment only.
  const envClaims = { userId: orgA.member.id, environmentId: orgA.envA.id };
  await expect(statusOf(assertUserActorEnvironmentAccess(envClaims, orgA.envA))).resolves.toBe(200);
  await expect(statusOf(assertUserActorEnvironmentAccess(envClaims, orgA.envB))).resolves.toBe(403);

  // An env claim that matches wins; one that doesn't falls back to the org rule.
  const bothClaims = {
    userId: orgA.member.id,
    environmentId: orgA.envA.id,
    organizationId: orgA.organization.id,
  };
  await expect(statusOf(assertUserActorEnvironmentAccess(bothClaims, orgA.envA))).resolves.toBe(
    200
  );
  await expect(statusOf(assertUserActorEnvironmentAccess(bothClaims, orgA.envB))).resolves.toBe(
    200
  );
  await expect(statusOf(assertUserActorEnvironmentAccess(bothClaims, orgB.envA))).resolves.toBe(
    403
  );

  // A claimless caller is unaffected.
  await expect(statusOf(assertUserActorEnvironmentAccess(undefined, orgA.envA))).resolves.toBe(200);
});
