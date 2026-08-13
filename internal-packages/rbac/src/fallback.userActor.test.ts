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

postgresTest(
  "authenticateUserActor: member is allowed, non-member is denied",
  async ({ prisma }) => {
    const org = await prisma.organization.create({
      data: { slug: `org-${Date.now()}`, title: "Org" },
    });
    const member = await seedUser(prisma as PrismaClient, "member@example.test");
    const stranger = await seedUser(prisma as PrismaClient, "stranger@example.test");
    await prisma.orgMember.create({
      data: { organizationId: org.id, userId: member.id },
    });

    const controller = new RoleBaseAccessFallback(prisma as PrismaClient, {
      userActorSecret: SECRET,
    }).create();

    const memberToken = await signUserActorToken(SECRET, {
      userId: member.id,
      client: "test",
    });
    const strangerToken = await signUserActorToken(SECRET, {
      userId: stranger.id,
      client: "test",
    });

    // Member with a capless token keeps the read:all default.
    const memberResult = await controller.authenticateUserActor(uatRequest(memberToken), {
      organizationId: org.id,
    });
    expect(memberResult.ok).toBe(true);
    if (memberResult.ok) {
      expect(memberResult.ability.can("read", { type: "runs", id: "run_x" })).toBe(true);
    }

    // Non-member is denied at the ability layer, not handed a usable ability.
    const strangerResult = await controller.authenticateUserActor(uatRequest(strangerToken), {
      organizationId: org.id,
    });
    expect(strangerResult.ok).toBe(false);
    if (!strangerResult.ok) {
      expect(strangerResult.status).toBe(403);
    }
  },
  120_000
);
