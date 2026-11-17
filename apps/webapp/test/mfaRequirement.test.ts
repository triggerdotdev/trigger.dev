import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect, it, vi } from "vitest";
import {
  isMfaRequiredByOrganization,
  isMfaSetupRequired,
  isMfaVerificationFresh,
  stepUpWindowMinutes,
} from "~/services/mfa/mfaRequirement.server";

vi.setConfig({ testTimeout: 60_000 });

let seq = 0;

async function createUser(prisma: PrismaClient, mfaEnabledAt: Date | null = null) {
  seq++;
  return prisma.user.create({
    data: {
      email: `mfa-${seq}-${Date.now()}@example.com`,
      authenticationMethod: "MAGIC_LINK",
      mfaEnabledAt,
    },
  });
}

async function createOrg(
  prisma: PrismaClient,
  memberIds: string[],
  data: {
    mfaRequired?: boolean;
    mfaStepUpActions?: string[];
    mfaStepUpWindowMinutes?: number;
    deletedAt?: Date;
  } = {}
) {
  seq++;
  return prisma.organization.create({
    data: {
      slug: `mfa-org-${seq}-${Date.now()}`,
      title: "MFA org",
      ...data,
      members: { create: memberIds.map((userId) => ({ userId, role: "MEMBER" as const })) },
    },
  });
}

describe("isMfaSetupRequired", () => {
  // Catches: members of orgs without the requirement being locked out.
  postgresTest("is false when none of the user's orgs requires MFA", async ({ prisma }) => {
    const user = await createUser(prisma);
    await createOrg(prisma, [user.id]);
    expect(await isMfaSetupRequired(user.id, prisma)).toBe(false);
  });

  // Catches: platform admins being locked out by an org they support.
  postgresTest("is false for a platform admin without MFA", async ({ prisma }) => {
    const user = await createUser(prisma);
    await prisma.user.update({ where: { id: user.id }, data: { admin: true } });
    await createOrg(prisma, [user.id], { mfaRequired: true });
    expect(await isMfaSetupRequired(user.id, prisma)).toBe(false);
  });

  // Catches: a member without MFA keeping access to an org that requires it.
  postgresTest(
    "is true for a member without MFA of an org that requires it",
    async ({ prisma }) => {
      const user = await createUser(prisma);
      await createOrg(prisma, [user.id]);
      await createOrg(prisma, [user.id], { mfaRequired: true });
      expect(await isMfaSetupRequired(user.id, prisma)).toBe(true);
      // Setting MFA up lets the member in straight away.
      await prisma.user.update({ where: { id: user.id }, data: { mfaEnabledAt: new Date() } });
      expect(await isMfaSetupRequired(user.id, prisma)).toBe(false);
    }
  );

  // Catches: a cached "no MFA needed" answer outliving a new membership.
  postgresTest(
    "locks a member out the moment they join an org that requires MFA",
    async ({ prisma }) => {
      const user = await createUser(prisma);
      expect(await isMfaSetupRequired(user.id, prisma)).toBe(false);
      await createOrg(prisma, [user.id], { mfaRequired: true });
      expect(await isMfaSetupRequired(user.id, prisma)).toBe(true);
    }
  );

  // Catches: a deleted org, or someone else's org, locking a user out.
  postgresTest("ignores deleted orgs and orgs the user isn't in", async ({ prisma }) => {
    const user = await createUser(prisma);
    const other = await createUser(prisma);
    await createOrg(prisma, [user.id], { mfaRequired: true, deletedAt: new Date() });
    await createOrg(prisma, [other.id], { mfaRequired: true });
    expect(await isMfaSetupRequired(user.id, prisma)).toBe(false);
  });
});

describe("isMfaRequiredByOrganization", () => {
  // Catches: a member turning MFA off while an org still requires it.
  postgresTest("is true even when the member already has MFA", async ({ prisma }) => {
    const user = await createUser(prisma, new Date());
    await createOrg(prisma, [user.id], { mfaRequired: true });
    expect(await isMfaRequiredByOrganization(user.id, prisma)).toBe(true);
    expect(await isMfaSetupRequired(user.id, prisma)).toBe(false);
  });
});

describe("stepUpWindowMinutes", () => {
  // Catches: a check asked for an action no org protects.
  postgresTest("is undefined when no org asks for the action", async ({ prisma }) => {
    const user = await createUser(prisma);
    await createOrg(prisma, [user.id], { mfaStepUpActions: ["accessTokens"] });
    expect(await stepUpWindowMinutes(user.id, "environmentVariables", undefined, prisma)).toBe(
      undefined
    );
  });

  // Catches: one org's window or actions applied to another org's pages.
  postgresTest(
    "scopes to the given org, otherwise takes the shortest window",
    async ({ prisma }) => {
      const user = await createUser(prisma);
      const strict = await createOrg(prisma, [user.id], {
        mfaStepUpActions: ["accessTokens"],
        mfaStepUpWindowMinutes: 5,
      });
      const relaxed = await createOrg(prisma, [user.id], {
        mfaStepUpActions: ["accessTokens", "environmentVariables"],
        mfaStepUpWindowMinutes: 30,
      });

      expect(await stepUpWindowMinutes(user.id, "accessTokens", undefined, prisma)).toBe(5);
      expect(await stepUpWindowMinutes(user.id, "accessTokens", relaxed.id, prisma)).toBe(30);
      expect(await stepUpWindowMinutes(user.id, "environmentVariables", strict.id, prisma)).toBe(
        undefined
      );
    }
  );

  // Catches: an org's setting applied to users outside it.
  postgresTest("doesn't apply an org's setting to non-members", async ({ prisma }) => {
    const user = await createUser(prisma);
    const owner = await createUser(prisma);
    const org = await createOrg(prisma, [owner.id], { mfaStepUpActions: ["accessTokens"] });
    expect(await stepUpWindowMinutes(user.id, "accessTokens", org.id, prisma)).toBe(undefined);
  });
});

describe("isMfaVerificationFresh", () => {
  const now = 1_000_000_000;

  // Catches: an off-by-one at the window's edge.
  it("accepts a check inside the window and rejects one at or past it", () => {
    expect(isMfaVerificationFresh(now - 4 * 60_000, 5, now)).toBe(true);
    expect(isMfaVerificationFresh(now - 5 * 60_000, 5, now)).toBe(false);
  });

  // Catches: a missing or tampered timestamp counting as a passed check.
  it("rejects missing and malformed timestamps", () => {
    expect(isMfaVerificationFresh(undefined, 5, now)).toBe(false);
    expect(isMfaVerificationFresh(String(now), 5, now)).toBe(false);
  });

  // Catches: clock skew between instances asking for a code just entered.
  it("accepts a check stamped by an instance whose clock runs slightly ahead", () => {
    expect(isMfaVerificationFresh(now + 50, 5, now)).toBe(true);
  });
});
