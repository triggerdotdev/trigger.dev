import { afterEach, describe, expect, it, vi } from "vitest";

// Only what the audit log host reads; recording starts off, as in production.
vi.mock("~/env.server", async () =>
  (await import("./helpers/auditLogPlugin")).auditRecordingEnv({ env: {} })
);

import { auditLogs } from "~/services/auditLogs/auditLogs.server";
import {
  enableAuditRecording,
  installAuditLogPlugin,
  uninstallAuditLogPlugin,
} from "./helpers/auditLogPlugin";

describe("audit log recording in tests", () => {
  let disableRecording: (() => void) | undefined;
  afterEach(() => {
    disableRecording?.();
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

    auditLogs.record({
      category: "members",
      action: "member.removed",
      organizationId: "org_1",
      target: { type: "member", id: "user_1", name: null },
    });
    await auditLogs.flush();

    expect(recorded).toEqual([]);
  });
});
