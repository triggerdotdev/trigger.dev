import type { PrismaClient } from "@trigger.dev/database";
import { signUserActorToken } from "@trigger.dev/plugins";
import { postgresTest } from "@internal/testcontainers";
import { expect } from "vitest";
import { RoleBaseAccessFallback } from "./fallback.js";

const SECRET = "test-user-actor-secret";

function uatRequest(token: string): Request {
  return new Request("https://example.test", {
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function seedUser(prisma: PrismaClient, email: string, admin = false) {
  return prisma.user.create({
    data: { email, authenticationMethod: "MAGIC_LINK", admin },
  });
}

async function uat(userId: string) {
  return signUserActorToken(SECRET, { userId, client: "test" });
}

postgresTest(
  "authenticateUserActor: scoped membership floor",
  async ({ prisma }) => {
    const p = prisma as PrismaClient;
    const org = await p.organization.create({
      data: { slug: `org-${Date.now()}`, title: "Org" },
    });
    const project = await p.project.create({
      data: {
        slug: `proj-${Date.now()}`,
        name: "Project",
        externalRef: `ref-${Date.now()}`,
        organizationId: org.id,
      },
    });
    const member = await seedUser(p, "member@example.test");
    const stranger = await seedUser(p, "stranger@example.test");
    const admin = await seedUser(p, "admin@example.test", true);
    await p.orgMember.create({ data: { organizationId: org.id, userId: member.id } });

    const controller = new RoleBaseAccessFallback(p, { userActorSecret: SECRET }).create();

    // Member with a capless token keeps the read:all default.
    const memberResult = await controller.authenticateUserActor(uatRequest(await uat(member.id)), {
      organizationId: org.id,
    });
    expect(memberResult.ok).toBe(true);
    if (memberResult.ok) {
      expect(memberResult.ability.can("read", { type: "runs", id: "run_x" })).toBe(true);
    }

    // Non-member is denied at the ability layer, not handed a usable ability.
    const strangerResult = await controller.authenticateUserActor(
      uatRequest(await uat(stranger.id)),
      { organizationId: org.id }
    );
    expect(strangerResult.ok).toBe(false);
    if (!strangerResult.ok) expect(strangerResult.status).toBe(403);

    // A token for a user that no longer exists fails closed.
    const ghostResult = await controller.authenticateUserActor(uatRequest(await uat("usr_ghost")), {
      organizationId: org.id,
    });
    expect(ghostResult.ok).toBe(false);
    if (!ghostResult.ok) expect(ghostResult.status).toBe(401);

    // A platform admin is exempt from the membership floor.
    const adminResult = await controller.authenticateUserActor(uatRequest(await uat(admin.id)), {
      organizationId: org.id,
    });
    expect(adminResult.ok).toBe(true);

    // A project-only scope resolves through the project's org: non-member denied.
    const projectResult = await controller.authenticateUserActor(
      uatRequest(await uat(stranger.id)),
      { projectId: project.id }
    );
    expect(projectResult.ok).toBe(false);
    if (!projectResult.ok) expect(projectResult.status).toBe(403);
  },
  120_000
);

postgresTest(
  "authenticateUserActor: unscoped context skips the floor and never queries the user",
  async ({ prisma }) => {
    const p = prisma as PrismaClient;
    const controller = new RoleBaseAccessFallback(p, { userActorSecret: SECRET }).create();

    // A user that doesn't exist: if the unscoped path ran the lookup this would 401.
    const result = await controller.authenticateUserActor(uatRequest(await uat("usr_ghost")), {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ability.can("read", { type: "runs", id: "run_x" })).toBe(true);
    }
  },
  120_000
);
