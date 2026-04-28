import { containerTest } from "@internal/testcontainers";
import { createCookieSessionStorage, type Session } from "@remix-run/node";
import { describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });
import {
  DEFAULT_SESSION_DURATION_SECONDS,
  ensureSessionIssuedAt,
  getAllowedSessionOptions,
  getEffectiveSessionDuration,
  getOrganizationSessionCap,
  isAllowedSessionDuration,
  isSessionExpired,
  SESSION_DURATION_OPTIONS,
  SESSION_ISSUED_AT_KEY,
  setSessionIssuedAt,
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

describe("isSessionExpired", () => {
  it("returns false when issuedAt is missing (legacy cookie)", async () => {
    const session = await makeEmptySession();
    expect(isSessionExpired(session, oneHour)).toBe(false);
  });

  it("returns false when within the duration window", async () => {
    const session = await makeEmptySession();
    const now = 1_000_000_000_000;
    setSessionIssuedAt(session, now - 60 * 1000);
    expect(isSessionExpired(session, oneHour, now)).toBe(false);
  });

  it("returns true when older than the duration window", async () => {
    const session = await makeEmptySession();
    const now = 1_000_000_000_000;
    setSessionIssuedAt(session, now - (oneHour + 1) * 1000);
    expect(isSessionExpired(session, oneHour, now)).toBe(true);
  });
});

describe("ensureSessionIssuedAt", () => {
  it("sets issuedAt and returns true when missing", async () => {
    const session = await makeEmptySession();
    const now = 1_700_000_000_000;
    expect(ensureSessionIssuedAt(session, now)).toBe(true);
    expect(session.get(SESSION_ISSUED_AT_KEY)).toBe(now);
  });

  it("leaves issuedAt unchanged and returns false when already set", async () => {
    const session = await makeEmptySession();
    const original = 1_500_000_000_000;
    setSessionIssuedAt(session, original);
    expect(ensureSessionIssuedAt(session, 1_700_000_000_000)).toBe(false);
    expect(session.get(SESSION_ISSUED_AT_KEY)).toBe(original);
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
      await createOrgWithMember(prisma, "tight-org", user.id, oneHour);
      await createOrgWithMember(prisma, "uncapped-org", user.id, null);

      const cap = await getOrganizationSessionCap(user.id, prisma);
      expect(cap).toBe(oneHour);
    }
  );

  containerTest("ignores soft-deleted organizations", async ({ prisma }) => {
    const user = await createUser(prisma, "deleted-org-user@test.com");
    const tight = await createOrgWithMember(prisma, "deleted-tight", user.id, oneHour);
    await createOrgWithMember(prisma, "active-loose", user.id, oneDay);

    await prisma.organization.update({
      where: { id: tight.id },
      data: { deletedAt: new Date() },
    });

    const cap = await getOrganizationSessionCap(user.id, prisma);
    expect(cap).toBe(oneDay);
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
      expect(result.durationSeconds).toBe(oneDay);
    }
  );

  containerTest("caps the user setting at the most restrictive org cap", async ({ prisma }) => {
    const user = await createUser(prisma, "effective-capped@test.com", oneYear);
    await createOrgWithMember(prisma, "effective-capped-org", user.id, oneHour);

    const result = await getEffectiveSessionDuration(user.id, prisma);
    expect(result.userSettingSeconds).toBe(oneYear);
    expect(result.orgCapSeconds).toBe(oneHour);
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
      expect(result.durationSeconds).toBe(DEFAULT_SESSION_DURATION_SECONDS);
    }
  );
});
