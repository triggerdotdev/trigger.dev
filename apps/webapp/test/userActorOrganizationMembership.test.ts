// The live membership check against a real Postgres: only a current member of a live organization
// is served. Nothing is stubbed but `db.server`, which is handed the container's client, so the
// `deletedAt: null` predicate and the membership join are the real query.
import type { PrismaClient } from "@trigger.dev/database";
import { postgresTest } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

const db = vi.hoisted(() => ({ client: null as unknown as PrismaClient }));

vi.mock("~/db.server", () => ({
  get prisma() {
    return db.client;
  },
  get $replica() {
    return db.client;
  },
}));

import {
  assertUserActorEnvironmentAccess,
  assertUserActorOrganizationAccess,
  resolveUserActorEnvironmentScope,
} from "~/services/userActorEnvironment.server";

async function seed(prisma: PrismaClient, opts: { deleted?: boolean } = {}) {
  db.client = prisma;

  const member = await prisma.user.create({
    data: { email: "member@example.com", authenticationMethod: "MAGIC_LINK" },
  });
  const stranger = await prisma.user.create({
    data: { email: "stranger@example.com", authenticationMethod: "MAGIC_LINK" },
  });
  const organization = await prisma.organization.create({
    data: {
      title: "test",
      slug: "test",
      ...(opts.deleted ? { deletedAt: new Date() } : {}),
      members: { create: { userId: member.id, role: "ADMIN" } },
    },
  });
  const project = await prisma.project.create({
    data: {
      name: "test",
      slug: "test",
      externalRef: "proj_test",
      organizationId: organization.id,
    },
  });
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      slug: "prod",
      type: "PRODUCTION",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: "tr_prod_test",
      pkApiKey: "pk_prod_test",
      shortcode: "test",
    },
  });

  // A second project of the same organization: what the agent reads cross-project.
  const sibling = await prisma.project.create({
    data: {
      name: "sibling",
      slug: "sibling",
      externalRef: "proj_sibling",
      organizationId: organization.id,
    },
  });

  return { member, stranger, organization, project, sibling, environment };
}

function claims(userId: string, organizationId: string, environmentId: string) {
  return { userId, client: "dashboard-agent", organizationId, environmentId };
}

describe("user-actor organization membership", () => {
  postgresTest("serves a current member of a live organization", async ({ prisma }) => {
    const { member, organization, environment } = await seed(prisma);
    const actor = claims(member.id, organization.id, environment.id);

    await expect(
      assertUserActorOrganizationAccess(actor, organization.id)
    ).resolves.toBeUndefined();
    await expect(assertUserActorEnvironmentAccess(actor, environment)).resolves.toBeUndefined();
  });

  postgresTest("403s a user who isn't a member", async ({ prisma }) => {
    const { stranger, organization, environment } = await seed(prisma);
    const actor = claims(stranger.id, organization.id, environment.id);

    await expect(assertUserActorOrganizationAccess(actor, organization.id)).rejects.toMatchObject({
      status: 403,
    });
    await expect(assertUserActorEnvironmentAccess(actor, environment)).rejects.toMatchObject({
      status: 403,
    });
  });

  postgresTest("403s a member of a soft-deleted organization", async ({ prisma }) => {
    const { member, organization, environment } = await seed(prisma, { deleted: true });
    const actor = claims(member.id, organization.id, environment.id);

    await expect(assertUserActorOrganizationAccess(actor, organization.id)).rejects.toMatchObject({
      status: 403,
    });
    await expect(assertUserActorEnvironmentAccess(actor, environment)).rejects.toMatchObject({
      status: 403,
    });
  });

  postgresTest("403s a token claiming another organization", async ({ prisma }) => {
    const { member, environment } = await seed(prisma);
    const actor = claims(member.id, "org_other", environment.id);

    await expect(assertUserActorEnvironmentAccess(actor, environment)).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe("user-actor project scope on an org-scoped route", () => {
  postgresTest("answers the token's own project project-wide too", async ({ prisma }) => {
    const { member, organization, project, environment } = await seed(prisma);
    const actor = claims(member.id, organization.id, environment.id);

    const scope = await resolveUserActorEnvironmentScope(
      actor,
      { projectId: project.id },
      { organizationScoped: true }
    );

    expect(scope).toEqual({ scoped: false });
  });

  postgresTest("still narrows a token with no organization claim", async ({ prisma }) => {
    const { member, project, environment } = await seed(prisma);
    const actor = { userId: member.id, client: "dashboard-agent", environmentId: environment.id };

    const scope = await resolveUserActorEnvironmentScope(
      actor,
      { projectId: project.id },
      { organizationScoped: true }
    );

    expect(scope).toMatchObject({ scoped: true, environmentId: environment.id });
  });

  postgresTest("answers a sibling project of the same organization", async ({ prisma }) => {
    const { member, organization, sibling, environment } = await seed(prisma);
    const actor = claims(member.id, organization.id, environment.id);

    const scope = await resolveUserActorEnvironmentScope(
      actor,
      { projectId: sibling.id },
      { organizationScoped: true }
    );

    expect(scope).toEqual({ scoped: false });
  });

  postgresTest("403s that same sibling project without the opt-in", async ({ prisma }) => {
    const { member, organization, sibling, environment } = await seed(prisma);
    const actor = claims(member.id, organization.id, environment.id);

    await expect(
      resolveUserActorEnvironmentScope(actor, { projectId: sibling.id })
    ).rejects.toMatchObject({ status: 403 });
  });
});
