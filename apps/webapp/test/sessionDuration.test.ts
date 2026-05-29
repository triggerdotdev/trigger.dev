import { describe, expect, it, vi } from "vitest";

// `~/db.server` eagerly calls $connect() on the singleton Prisma client at
// module load. Without this mock the test process tries to reach DATABASE_URL
// (defaults to localhost:5432) and emits an unhandled rejection that fails the
// run. Tests still get a real Prisma client via the testcontainer fixture.
vi.mock("~/db.server", () => ({
  prisma: {},
  $replica: {},
}));

import { containerTest } from "@internal/testcontainers";
import { createCookieSessionStorage, type Session } from "@remix-run/node";

vi.setConfig({ testTimeout: 60_000 });
import {
  commitAuthenticatedSession,
  DEFAULT_SESSION_DURATION_SECONDS,
  getAllowedSessionOptions,
  getEffectiveSessionDuration,
  getOrganizationSessionCap,
  isAllowedSessionDuration,
  SESSION_DURATION_OPTIONS,
} from "../app/services/sessionDuration.server";

const oneHour = 60 * 60;
const oneDay = 60 * 60 * 24;
const oneYear = DEFAULT_SESSION_DURATION_SECONDS;

const sessionStorage = createCookieSessionStorage({
  cookie: { name: "__test_session", secrets: ["test"] },
});

async function makeEmptySession(): Promise<Session> {
  return sessionStorage.getSession();
}

describe("isAllowedSessionDuration", () => {
  it("accepts every value in the dropdown options", () => {
    for (const option of SESSION_DURATION_OPTIONS) {
      expect(isAllowedSessionDuration(option.value)).toBe(true);
    }
  });

  it("rejects values not in the dropdown", () => {
    expect(isAllowedSessionDuration(1)).toBe(false);
    expect(isAllowedSessionDuration(7 * oneDay)).toBe(false);
    expect(isAllowedSessionDuration(0)).toBe(false);
    expect(isAllowedSessionDuration(-1)).toBe(false);
  });
});

describe("getAllowedSessionOptions", () => {
  it("returns all options when there is no org cap", () => {
    const options = getAllowedSessionOptions(null, oneYear);
    expect(options).toEqual(SESSION_DURATION_OPTIONS);
  });

  it("filters out options larger than the org cap", () => {
    const options = getAllowedSessionOptions(oneHour, oneHour);
    expect(options.map((o) => o.value)).toEqual([60 * 5, 60 * 30, 60 * 60]);
  });

  it("includes the user's current value even when it exceeds the cap, so the form stays valid", () => {
    const options = getAllowedSessionOptions(oneHour, oneYear);
    expect(options.some((o) => o.value === oneYear)).toBe(true);
    expect(options.some((o) => o.value === oneHour)).toBe(true);
  });

  it("does not duplicate the current value when it is already within the cap", () => {
    const options = getAllowedSessionOptions(oneDay, oneHour);
    const oneHourCount = options.filter((o) => o.value === oneHour).length;
    expect(oneHourCount).toBe(1);
  });
});

async function createUser(prisma: any, email: string, sessionDuration?: number) {
  return prisma.user.create({
    data: {
      email,
      authenticationMethod: "MAGIC_LINK",
      ...(sessionDuration !== undefined ? { sessionDuration } : {}),
    },
  });
}

async function createOrgWithMember(
  prisma: any,
  slug: string,
  userId: string,
  maxSessionDuration: number | null
) {
  return prisma.organization.create({
    data: {
      title: `Org ${slug}`,
      slug,
      maxSessionDuration,
      members: { create: { userId, role: "ADMIN" } },
    },
  });
}

describe("getOrganizationSessionCap", () => {
  containerTest("returns null when the user has no orgs with a cap set", async ({ prisma }) => {
    const user = await createUser(prisma, "no-cap@test.com");
    await createOrgWithMember(prisma, "no-cap-org", user.id, null);

    const cap = await getOrganizationSessionCap(user.id, prisma);
    expect(cap).toBeNull();
  });

  containerTest(
    "returns the most restrictive cap across orgs, ignoring nulls",
    async ({ prisma }) => {
      const user = await createUser(prisma, "multi-org@test.com");
      await createOrgWithMember(prisma, "loose-org", user.id, oneDay);
      const tight = await createOrgWithMember(prisma, "tight-org", user.id, oneHour);
      await createOrgWithMember(prisma, "uncapped-org", user.id, null);

      const cap = await getOrganizationSessionCap(user.id, prisma);
      expect(cap).toEqual({ orgCapSeconds: oneHour, cappingOrgId: tight.id });
    }
  );

  containerTest("ignores soft-deleted organizations", async ({ prisma }) => {
    const user = await createUser(prisma, "deleted-org-user@test.com");
    const tight = await createOrgWithMember(prisma, "deleted-tight", user.id, oneHour);
    const loose = await createOrgWithMember(prisma, "active-loose", user.id, oneDay);

    await prisma.organization.update({
      where: { id: tight.id },
      data: { deletedAt: new Date() },
    });

    const cap = await getOrganizationSessionCap(user.id, prisma);
    expect(cap).toEqual({ orgCapSeconds: oneDay, cappingOrgId: loose.id });
  });
});

describe("getEffectiveSessionDuration", () => {
  containerTest(
    "returns the user setting when no org cap is set",
    async ({ prisma }) => {
      const user = await createUser(prisma, "effective-no-cap@test.com", oneDay);
      await createOrgWithMember(prisma, "effective-no-cap-org", user.id, null);

      const result = await getEffectiveSessionDuration(user.id, prisma);
      expect(result.userSettingSeconds).toBe(oneDay);
      expect(result.orgCapSeconds).toBeNull();
      expect(result.cappingOrgId).toBeNull();
      expect(result.durationSeconds).toBe(oneDay);
    }
  );

  containerTest("caps the user setting at the most restrictive org cap", async ({ prisma }) => {
    const user = await createUser(prisma, "effective-capped@test.com", oneYear);
    const org = await createOrgWithMember(prisma, "effective-capped-org", user.id, oneHour);

    const result = await getEffectiveSessionDuration(user.id, prisma);
    expect(result.userSettingSeconds).toBe(oneYear);
    expect(result.orgCapSeconds).toBe(oneHour);
    expect(result.cappingOrgId).toBe(org.id);
    expect(result.durationSeconds).toBe(oneHour);
  });

  containerTest(
    "returns the user setting when it is already smaller than the org cap",
    async ({ prisma }) => {
      const user = await createUser(prisma, "effective-user-smaller@test.com", 60 * 5);
      await createOrgWithMember(prisma, "effective-user-smaller-org", user.id, oneHour);

      const result = await getEffectiveSessionDuration(user.id, prisma);
      expect(result.durationSeconds).toBe(60 * 5);
    }
  );

  containerTest(
    "uses the default when the user has no row (defensive fallback)",
    async ({ prisma }) => {
      const result = await getEffectiveSessionDuration("nonexistent-user-id", prisma);
      expect(result.userSettingSeconds).toBe(DEFAULT_SESSION_DURATION_SECONDS);
      expect(result.orgCapSeconds).toBeNull();
      expect(result.cappingOrgId).toBeNull();
      expect(result.durationSeconds).toBe(DEFAULT_SESSION_DURATION_SECONDS);
    }
  );
});

describe("commitAuthenticatedSession", () => {
  containerTest(
    "stamps User.nextSessionEnd at now + user setting when no org cap",
    async ({ prisma }) => {
      const user = await createUser(prisma, "commit-no-cap@test.com", oneHour);
      const session = await makeEmptySession();
      const now = 1_700_000_000_000;

      await commitAuthenticatedSession(session, user.id, now, prisma);

      const updated = await prisma.user.findFirstOrThrow({ where: { id: user.id } });
      expect(updated.nextSessionEnd?.getTime()).toBe(now + oneHour * 1000);
    }
  );

  containerTest(
    "stamps User.nextSessionEnd against the tightest org cap when smaller than user setting",
    async ({ prisma }) => {
      const user = await createUser(prisma, "commit-capped@test.com", oneYear);
      await createOrgWithMember(prisma, "commit-capped-org", user.id, oneHour);
      const session = await makeEmptySession();
      const now = 1_700_000_000_000;

      await commitAuthenticatedSession(session, user.id, now, prisma);

      const updated = await prisma.user.findFirstOrThrow({ where: { id: user.id } });
      expect(updated.nextSessionEnd?.getTime()).toBe(now + oneHour * 1000);
    }
  );

  containerTest("resets nextSessionEnd to a fresh window on each commit", async ({ prisma }) => {
    const user = await createUser(prisma, "commit-reset@test.com", oneHour);
    const session = await makeEmptySession();

    await commitAuthenticatedSession(session, user.id, 1_700_000_000_000, prisma);
    const first = await prisma.user.findFirstOrThrow({ where: { id: user.id } });

    await commitAuthenticatedSession(session, user.id, 1_700_000_060_000, prisma);
    const second = await prisma.user.findFirstOrThrow({ where: { id: user.id } });

    expect(second.nextSessionEnd?.getTime()).toBeGreaterThan(first.nextSessionEnd!.getTime());
    expect(second.nextSessionEnd?.getTime()).toBe(1_700_000_060_000 + oneHour * 1000);
  });
});
