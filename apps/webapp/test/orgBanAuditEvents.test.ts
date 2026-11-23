import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import type { AccessPolicyBanCredentialChanges } from "@trigger.dev/plugins";
import { afterEach, describe, expect, vi } from "vitest";

// The audit events for what an org ban rotated and revoked, recorded through the real recording
// gate against a real database: Trigger.dev support as the actor, the staff member kept internal.

vi.setConfig({ testTimeout: 60_000 });

const db = vi.hoisted(() => ({ client: null as unknown as PrismaClient }));

vi.mock("~/env.server", async () => {
  const { auditRecordingEnv } = await import("./helpers/auditLogPlugin");
  return auditRecordingEnv({
    env: {
      // The per-org recording flag's settings, at their schema defaults: a hand-built env has none.
      AUDIT_LOGS_RECORDING_FLAG_CACHE_TTL_MS: 30_000,
      AUDIT_LOGS_RECORDING_FLAG_CACHE_MAX_ENTRIES: 50_000,
      AUDIT_LOGS_RECORDING_FLAG_LOOKUP_TIMEOUT_MS: 5_000,
    },
  });
});

vi.mock("~/db.server", () => ({
  get prisma() {
    return db.client;
  },
  get $replica() {
    return db.client;
  },
}));

import { auditLogs } from "~/services/auditLogs/auditLogs.server";
import { recordOrgBanCredentialChanges } from "~/services/auditLogs/orgBanAuditEvents.server";
import { createTestOrgProjectWithMember } from "./fixtures/environmentVariablesFixtures";
import {
  enableAuditRecording,
  installAuditLogPlugin,
  uninstallAuditLogPlugin,
} from "./helpers/auditLogPlugin";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  uninstallAuditLogPlugin();
});

/**
 * A ban of `organizationId` that rotated one root key, ended an older one's grace period and
 * revoked an additional key and a PAT.
 */
function banChanges(organizationId: string, projectId: string): AccessPolicyBanCredentialChanges {
  return {
    organizationId,
    bannedAt: new Date("2026-11-23T10:00:00.000Z"),
    staffUserId: "staff_user_1",
    rotatedRootKeys: [
      {
        environmentId: "env_prod",
        projectId,
        environmentType: "PRODUCTION",
        previousKeyLast4: "old1",
        newKeyLast4: "new1",
      },
    ],
    graceEndedRootKeys: [
      { environmentId: "env_prod", projectId, environmentType: "PRODUCTION", keyLast4: "grc1" },
    ],
    revokedApiKeys: [
      {
        id: "apikey_1",
        name: "CI",
        last4: "ab12",
        environmentId: "env_prod",
        projectId,
        environmentType: "PRODUCTION",
      },
    ],
    revokedPersonalAccessTokens: [
      { id: "pat_1", name: "laptop", last4: "ef56", userId: "member_1" },
    ],
  };
}

const staff = {
  actor: { type: "support", id: null },
  source: "staff",
  onBehalfOf: { userId: "staff_user_1" },
};

describe("org ban audit events", () => {
  // Catches: a credential the ban changed missing from the log, named wrongly, attributed to
  // anyone but Trigger.dev support, or a PAT event landing in the organization's log.
  postgresTest(
    "records each rotated and revoked credential as Trigger.dev support",
    async ({ prisma }) => {
      db.client = prisma;
      const { organization, project } = await createTestOrgProjectWithMember(prisma);
      const { recorded } = installAuditLogPlugin();
      cleanups.push(await enableAuditRecording());

      await recordOrgBanCredentialChanges(banChanges(organization.id, project.id));
      await auditLogs.flush();

      const where = {
        organizationId: organization.id,
        projectId: project.id,
        environmentId: "env_prod",
        environmentType: "PRODUCTION",
      };
      // The recording gate settles a PAT event, which has no organization, on its own: order varies.
      const inputs = recorded.map(({ input }) => input);
      expect(inputs).toHaveLength(4);
      expect(inputs).toEqual(
        expect.arrayContaining([
          {
            category: "credentials",
            action: "api_key.rotated",
            ...where,
            target: { type: "root_api_key", id: "env_prod", name: null },
            keyLast4s: ["old1", "new1"],
            changes: {
              previousKeyLast4: "old1",
              newKeyLast4: "new1",
              graceUntil: null,
              reason: "banned",
            },
            ...staff,
          },
          {
            category: "credentials",
            action: "api_key.revoked",
            ...where,
            target: { type: "root_api_key", id: "env_prod", name: null },
            keyLast4s: ["grc1"],
            changes: { reason: "banned" },
            ...staff,
          },
          {
            category: "credentials",
            action: "api_key.revoked",
            ...where,
            target: { type: "additional_api_key", id: "apikey_1", name: "CI" },
            keyLast4s: ["ab12"],
            changes: { reason: "banned" },
            ...staff,
          },
          {
            category: "credentials",
            action: "pat.revoked",
            organizationId: null,
            target: { type: "pat", id: "pat_1", name: "laptop" },
            keyLast4s: ["ef56"],
            changes: { reason: "banned" },
            ...staff,
          },
        ])
      );
    }
  );

  // Catches: a ban recording events for an organization that isn't recording.
  postgresTest("records nothing while recording is off", async ({ prisma }) => {
    db.client = prisma;
    const { organization, project } = await createTestOrgProjectWithMember(prisma);
    const { recorded } = installAuditLogPlugin();

    await recordOrgBanCredentialChanges(banChanges(organization.id, project.id));
    await auditLogs.flush();

    expect(recorded).toEqual([]);
  });
});
