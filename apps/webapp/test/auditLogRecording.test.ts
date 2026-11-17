import { createStandalonePostgresContainer } from "@internal/testcontainers";
import type { AuditLogInput } from "@trigger.dev/plugins";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type * as Database from "~/db.server";
import type * as AuditLogsModule from "~/services/auditLogs/auditLogs.server";
import { FEATURE_FLAG } from "~/v3/featureFlags";
import {
  enableAuditRecording,
  installAuditLogPlugin,
  uninstallAuditLogPlugin,
} from "./helpers/auditLogPlugin";

// Recording starts off, as in production. The per-org flag is read from a real database.
vi.mock("~/env.server", async (original) =>
  (await import("./helpers/auditLogPlugin")).auditRecordingEnv(await original())
);

vi.setConfig({ testTimeout: 30_000 });

let container: Awaited<ReturnType<typeof createStandalonePostgresContainer>>;
let database: typeof Database;
let auditLogs: typeof AuditLogsModule.auditLogs;

beforeAll(async () => {
  container = await createStandalonePostgresContainer();
  vi.stubEnv("DATABASE_URL", container.url);
  vi.stubEnv("CONTROL_PLANE_DATABASE_URL", container.url);
  vi.stubEnv("DATABASE_READ_REPLICA_URL", container.url);
  vi.stubEnv("CONTROL_PLANE_DATABASE_READ_REPLICA_URL", container.url);

  database = await import("~/db.server");
  ({ auditLogs } = await import("~/services/auditLogs/auditLogs.server"));
}, 120_000);

afterAll(async () => {
  await database?.$replica.$disconnect();
  await database?.prisma.$disconnect();
  await container?.container.stop();
  vi.unstubAllEnvs();
});

function memberRemoved(organizationId: string): AuditLogInput {
  return {
    category: "members",
    action: "member.removed",
    organizationId,
    target: { type: "member", id: "user_1", name: null },
  };
}

describe("audit log recording in tests", () => {
  let disableRecording: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await disableRecording?.();
    disableRecording = undefined;
    uninstallAuditLogPlugin();
  });

  // Catches: the shared helper not capturing events, or recording staying off, which would make
  // every call-site test pass while asserting nothing.
  it("captures what call sites record, with the input's overrides", async () => {
    const { recorded } = installAuditLogPlugin();
    disableRecording = await enableAuditRecording();

    auditLogs.record({
      category: "support",
      action: "support.session_started",
      organizationId: "org_1",
      target: { type: "user", id: "user_1", name: null },
      actor: { type: "support", id: null },
      source: "staff",
      onBehalfOf: { userId: "staff_1" },
    });
    await auditLogs.flush();

    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.input).toMatchObject({
      action: "support.session_started",
      actor: { type: "support", id: null },
      source: "staff",
      onBehalfOf: { userId: "staff_1" },
    });
  });

  // Catches: recording on by default in tests, so call sites would record where production doesn't.
  it("records nothing while recording is off", async () => {
    const { recorded } = installAuditLogPlugin();

    auditLogs.record(memberRemoved("org_1"));
    await auditLogs.flush();

    expect(recorded).toEqual([]);
  });

  // Catches: the helper bypassing the per-org gate instead of setting the global flag, or the
  // gate recording for an org without the flag once the env switch is on.
  it("records through the real flag: the global row, else the org's override", async () => {
    const { recorded } = installAuditLogPlugin();
    disableRecording = await enableAuditRecording();
    const key = FEATURE_FLAG.auditLogsRecording;
    const globalRow = await database.prisma.featureFlag.findFirst({ where: { key } });
    expect(globalRow?.value).toBe(true);

    await database.prisma.featureFlag.deleteMany({ where: { key } });
    const flagged = await database.prisma.organization.create({
      data: { title: "flagged", slug: `flagged-${Date.now()}`, featureFlags: { [key]: true } },
    });
    auditLogs.record(memberRemoved("org_without_flag"));
    auditLogs.record(memberRemoved(flagged.id));
    await auditLogs.flush();

    expect(recorded.map(({ input }) => input.organizationId)).toEqual([flagged.id]);
  });

  // Catches: the helper's undo leaving the global row behind, so later tests record while off.
  it("removes the global row it added when undone", async () => {
    const undo = await enableAuditRecording();
    await undo();

    await expect(
      database.prisma.featureFlag.findFirst({ where: { key: FEATURE_FLAG.auditLogsRecording } })
    ).resolves.toBeNull();
  });
});
