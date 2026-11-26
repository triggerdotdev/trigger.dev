import plugin from "@trigger.dev/rbac";
import type { PrismaClient } from "@trigger.dev/database";
import { createHash } from "node:crypto";
import { describe, expect, vi } from "vitest";
import { alertEngineTest } from "./helpers/alertEngineRedis";
import {
  createRuntimeEnvironment,
  createTestOrgProjectWithMember,
  uniqueId,
} from "./fixtures/environmentVariablesFixtures";

vi.setConfig({ testTimeout: 60_000 });

const ctx = vi.hoisted(() => {
  const defaults = {
    DATABASE_URL: "postgresql://unused:unused@localhost:5432/unused",
    DIRECT_URL: "postgresql://unused:unused@localhost:5432/unused",
    MAGIC_LINK_SECRET: "test-magic-link-secret",
    ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
    DEPLOY_REGISTRY_HOST: "registry.test",
    V4_DEPLOY_REGISTRY_HOST: "registry.test",
    CLICKHOUSE_URL: "http://localhost:8123",
  };
  for (const [key, value] of Object.entries(defaults)) process.env[key] ??= value;
  return {
    prisma: undefined as unknown as PrismaClient,
    rbac: undefined as unknown as Record<string, (...args: any[]) => any>,
  };
});

vi.mock(
  "~/mcp/confirm/storeInstance.server",
  async () => (globalThis as any).__alertConfirm ?? import("./helpers/mcpConfirm")
);
vi.mock("~/db.server", async () => {
  const { boundedIn } = await import("@trigger.dev/database");
  const proxy = new Proxy(
    {},
    { get: (_target, prop) => (ctx.prisma as unknown as Record<string, unknown>)[prop as string] }
  );
  return {
    prisma: proxy,
    $replica: proxy,
    $transaction: (db: PrismaClient, fn: Parameters<PrismaClient["$transaction"]>[0]) =>
      "$transaction" in db ? db.$transaction(fn) : fn(db),
    boundedIn,
  };
});
vi.mock("~/services/rbac.server", () => ({
  rbac: new Proxy(
    {},
    {
      get:
        (_, prop: string) =>
        (...args: unknown[]) =>
          ctx.rbac[prop](...args),
    }
  ),
}));

import type { McpIdentity } from "~/mcp/gate/types";
import { alertsManageTools } from "~/mcp/tools/alertsManage.server";
import { alertEvaluationJobId } from "~/v3/services/alerts/engine/evaluateAlertJob.server";
import * as confirmations from "./helpers/mcpConfirm";

const { approveAll, expectPending, resetConfirmations } = confirmations;
(globalThis as any).__alertConfirm = confirmations;

describe("alert management tools and the evaluation schedule", () => {
  // Catches: activate_alert not scheduling the alert, or stop_alert leaving its evaluation queued.
  alertEngineTest(
    "activate schedules and stop unschedules the alert",
    async ({ prisma, engine }) => {
      ctx.prisma = prisma;
      ctx.rbac = plugin.create(
        { primary: prisma, replica: prisma },
        { forceFallback: true }
      ) as any;
      resetConfirmations({ autoApprove: false });

      const a = await createTestOrgProjectWithMember(prisma);
      await prisma.organization.update({
        where: { id: a.organization.id },
        data: { featureFlags: { alertsEnabled: true } },
      });
      const env = await createRuntimeEnvironment(prisma, {
        projectId: a.project.id,
        organizationId: a.organization.id,
        type: "PRODUCTION",
        slug: "prod",
      });
      const channel = await prisma.projectAlertChannel.create({
        data: {
          friendlyId: uniqueId("alert_channel"),
          name: "ops",
          type: "EMAIL",
          projectId: a.project.id,
          properties: { email: "ops@example.com" },
          alertTypes: ["TASK_RUN"],
          environmentTypes: ["PRODUCTION"],
        },
      });
      const alert = await prisma.alert.create({
        data: {
          id: uniqueId("alert"),
          organizationId: a.organization.id,
          projectId: a.project.id,
          environmentId: env.id,
          capabilityKey: "queue.depth",
          params: { environmentId: env.id, scope: { type: "all" } },
          condition: { kind: "threshold", operator: ">", value: 10, windowSec: 60 },
          lifecycle: "stopped",
          notifiers: [{ type: "channel", channelId: channel.id }],
          createdBy: a.user.id,
          name: "depth",
        },
      });
      const pat = `tr_pat_${uniqueId("tok")}`;
      const token = await prisma.personalAccessToken.create({
        data: {
          name: "mcp",
          encryptedToken: {},
          obfuscatedToken: "tr_pat_****",
          hashedToken: createHash("sha256").update(pat).digest("hex"),
          userId: a.user.id,
        },
      });
      const identity: McpIdentity = { kind: "pat", userId: a.user.id, tokenId: token.id };
      const request = new Request("https://api.trigger.dev/mcp", {
        headers: { Authorization: `Bearer ${pat}` },
      });
      const once = (tool: string) =>
        alertsManageTools
          .find((t) => t.name === tool)!
          .handler(
            { projectRef: a.project.externalRef, environment: "prod", alertId: alert.id },
            identity,
            request
          );
      const call = async (tool: string) => {
        await expectPending(once(tool));
        await approveAll();
        return once(tool);
      };

      expect((await call("activate_alert")).isError).toBeUndefined();
      const scheduled = await engine.getJob(alertEvaluationJobId(alert.id));
      expect((await call("stop_alert")).isError).toBeUndefined();
      const unscheduled = await engine.getJob(alertEvaluationJobId(alert.id));

      expect(scheduled).toBeTruthy();
      expect(unscheduled).toBeNull();
    }
  );
});
