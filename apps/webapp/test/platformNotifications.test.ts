import { postgresTest } from "@internal/testcontainers";
import { type Prisma, type PrismaClient } from "@trigger.dev/database";
import { describe, expect, it, vi } from "vitest";
import {
  createDraftPlatformNotification,
  CreatePlatformNotificationSchema,
  getActivePlatformNotifications,
  getNextCliNotification,
  getRecentChangelogs,
  publishDraftPlatformNotification,
} from "~/services/platformNotifications.server";
import { isCliVersionEligible } from "~/services/platformNotificationVersionTargeting";

// Container provisioning on the first draft tests can exceed the 5s default.
vi.setConfig({ testTimeout: 60_000 });

function createNotificationInput({
  surface = "CLI",
  minimumCliVersion,
}: {
  surface?: "CLI" | "WEBAPP";
  minimumCliVersion?: string;
} = {}) {
  return {
    title: "Notification",
    surface,
    scope: "GLOBAL" as const,
    endsAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    payload: {
      version: "1" as const,
      data: {
        type: surface === "CLI" ? ("info" as const) : ("card" as const),
        title: "Update available",
        description: "Update the CLI",
        ...(minimumCliVersion === undefined ? {} : { minimumCliVersion }),
      },
    },
  };
}

describe("platform notification minimum CLI version schema", () => {
  it("keeps existing unrestricted CLI payloads valid", () => {
    const result = CreatePlatformNotificationSchema.safeParse(createNotificationInput());

    expect(result.success).toBe(true);
  });

  it("trims and accepts a complete exact SemVer", () => {
    const result = CreatePlatformNotificationSchema.parse(
      createNotificationInput({ minimumCliVersion: " 4.5.7-beta.1+build.2 " })
    );

    expect(result.payload.data.minimumCliVersion).toBe("4.5.7-beta.1+build.2");
  });

  it.each(["4.5", ">=4.5.7", "4.5.x", "v4.5.7", "4.5.7 or newer", "01.2.3"])(
    "rejects non-exact SemVer %s",
    (minimumCliVersion) => {
      const result = CreatePlatformNotificationSchema.safeParse(
        createNotificationInput({ minimumCliVersion })
      );

      expect(result.success).toBe(false);
    }
  );

  it("rejects minimumCliVersion for WEBAPP notifications", () => {
    const result = CreatePlatformNotificationSchema.safeParse(
      createNotificationInput({ surface: "WEBAPP", minimumCliVersion: "4.5.7" })
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({ path: ["payload", "data", "minimumCliVersion"] })
      );
    }
  });
});

describe("CLI notification version eligibility", () => {
  it("allows unrestricted notifications without a request version", () => {
    expect(isCliVersionEligible(undefined, undefined)).toBe(true);
  });

  it.each([undefined, "", "4.5", "not-a-version"])(
    "rejects a targeted notification for missing or malformed request version %s",
    (cliVersion) => {
      expect(isCliVersionEligible("4.5.7", cliVersion)).toBe(false);
    }
  );

  it("fails closed for an invalid stored minimum version", () => {
    expect(isCliVersionEligible(">=4.5.7", "4.6.0")).toBe(false);
  });

  it.each([
    ["4.5.6", false],
    ["4.5.7-beta.1", false],
    ["4.5.7", true],
    ["4.5.7+build.9", true],
    ["4.6.0", true],
  ])("compares %s against inclusive minimum 4.5.7", (cliVersion, expected) => {
    expect(isCliVersionEligible("4.5.7", cliVersion)).toBe(expected);
  });

  it("uses SemVer precedence for prerelease minimums", () => {
    expect(isCliVersionEligible("4.5.7-beta.2", "4.5.7-beta.1")).toBe(false);
    expect(isCliVersionEligible("4.5.7-beta.2", "4.5.7-beta.2+build.1")).toBe(true);
    expect(isCliVersionEligible("4.5.7-beta.2", "4.5.7")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Drafts: a draft must never leak to users regardless of its (placeholder)
// dates — the `isDraft` gate is enforced in every user-facing read, and
// publishing sets real dates and flips the gate off.
// The DB is never mocked; every read runs against a real Postgres container.
// ---------------------------------------------------------------------------

let seq = 0;
const suffix = () => `${Date.now()}_${seq++}`;

const HOUR_MS = 60 * 60 * 1000;

function webappCardPayload(title: string): Prisma.InputJsonValue {
  return { version: "1", data: { type: "card", title, description: "body" } };
}

function changelogPayload(title: string): Prisma.InputJsonValue {
  return { version: "1", data: { type: "changelog", title, description: "body" } };
}

function cliInfoPayload(title: string): Prisma.InputJsonValue {
  return { version: "1", data: { type: "info", title, description: "body" } };
}

/** Seed a notification directly, so a draft can be given "active" dates and still be gated. */
async function seedNotification(
  prisma: PrismaClient,
  overrides: {
    surface: "WEBAPP" | "CLI";
    payload: Prisma.InputJsonValue;
    isDraft: boolean;
    startsAt?: Date;
    endsAt?: Date;
  }
) {
  const now = new Date();
  return prisma.platformNotification.create({
    data: {
      title: `admin_${suffix()}`,
      payload: overrides.payload,
      surface: overrides.surface,
      scope: "GLOBAL",
      startsAt: overrides.startsAt ?? new Date(now.getTime() - HOUR_MS),
      endsAt: overrides.endsAt ?? new Date(now.getTime() + HOUR_MS),
      isDraft: overrides.isDraft,
    },
    select: { id: true, friendlyId: true },
  });
}

describe("platform notification drafts are hidden from users", () => {
  postgresTest("getActivePlatformNotifications excludes drafts", async ({ prisma }) => {
    const published = await seedNotification(prisma, {
      surface: "WEBAPP",
      payload: webappCardPayload("published"),
      isDraft: false,
    });
    // Draft with dates that WOULD make it active — proves the gate, not the schedule.
    await seedNotification(prisma, {
      surface: "WEBAPP",
      payload: webappCardPayload("draft"),
      isDraft: true,
    });

    const { notifications } = await getActivePlatformNotifications(
      { userId: `usr_${suffix()}`, organizationId: `org_${suffix()}` },
      prisma
    );

    const ids = notifications.map((n) => n.id);
    expect(ids).toContain(published.id);
    expect(ids).toHaveLength(1);
  });

  postgresTest("getRecentChangelogs excludes drafts", async ({ prisma }) => {
    const published = await seedNotification(prisma, {
      surface: "WEBAPP",
      payload: changelogPayload("published changelog"),
      isDraft: false,
    });
    await seedNotification(prisma, {
      surface: "WEBAPP",
      payload: changelogPayload("draft changelog"),
      isDraft: true,
    });

    const changelogs = await getRecentChangelogs({ userId: `usr_${suffix()}` }, prisma);

    const ids = changelogs.map((c) => c.id);
    expect(ids).toContain(published.id);
    expect(ids).toHaveLength(1);
  });

  postgresTest("getNextCliNotification excludes drafts", async ({ prisma }) => {
    // Real user required: the returned notification records an interaction (FK to User).
    const user = await prisma.user.create({
      data: { email: `cli_${suffix()}@example.com`, authenticationMethod: "MAGIC_LINK" },
    });

    const published = await seedNotification(prisma, {
      surface: "CLI",
      payload: cliInfoPayload("published cli"),
      isDraft: false,
    });
    await seedNotification(prisma, {
      surface: "CLI",
      payload: cliInfoPayload("draft cli"),
      isDraft: true,
    });

    const next = await getNextCliNotification({ userId: user.id }, prisma);

    expect(next?.id).toBe(published.id);
  });

  postgresTest("publishing a draft flips isDraft and sets real dates", async ({ prisma }) => {
    const created = await createDraftPlatformNotification(
      {
        title: "admin label",
        payload: { version: "1", data: { type: "card", title: "to publish", description: "body" } },
        surface: "WEBAPP",
        scope: "GLOBAL",
      },
      prisma
    );
    expect(created.isOk()).toBe(true);
    const id = created._unsafeUnwrap().id;

    // Before publish: a draft, hidden from users.
    const before = await getActivePlatformNotifications(
      { userId: `usr_${suffix()}`, organizationId: `org_${suffix()}` },
      prisma
    );
    expect(before.notifications.map((n) => n.id)).not.toContain(id);

    const startsAt = new Date(Date.now() - 60 * 1000); // just now, within the last hour
    const endsAt = new Date(Date.now() + 24 * HOUR_MS);
    const published = await publishDraftPlatformNotification(
      { id, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() },
      prisma
    );
    expect(published.isOk()).toBe(true);

    const row = await prisma.platformNotification.findFirst({ where: { id } });
    expect(row?.isDraft).toBe(false);
    expect(row?.startsAt.toISOString()).toBe(startsAt.toISOString());
    expect(row?.endsAt.toISOString()).toBe(endsAt.toISOString());

    // After publish: now visible to users.
    const after = await getActivePlatformNotifications(
      { userId: `usr_${suffix()}`, organizationId: `org_${suffix()}` },
      prisma
    );
    expect(after.notifications.map((n) => n.id)).toContain(id);
  });
});
