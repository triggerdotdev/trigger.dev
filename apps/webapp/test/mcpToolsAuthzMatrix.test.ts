import { postgresTest } from "@internal/testcontainers";
import plugin, { signUserActorToken } from "@trigger.dev/rbac";
import type { PrismaClient } from "@trigger.dev/database";
import { createHash } from "node:crypto";
import { describe, expect, vi } from "vitest";
import {
  createRuntimeEnvironment,
  createTestOrgProjectWithMember,
  uniqueId,
} from "./fixtures/environmentVariablesFixtures";

const SECRET = "test-user-actor-secret";

vi.setConfig({ testTimeout: 60_000 });

vi.hoisted(() => {
  Object.assign(process.env, {
    DATABASE_URL: "postgresql://unused:unused@localhost:5432/unused",
    DIRECT_URL: "postgresql://unused:unused@localhost:5432/unused",
    MAGIC_LINK_SECRET: "magic-link-secret-for-tests",
    ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
    DEPLOY_REGISTRY_HOST: "registry.test",
    V4_DEPLOY_REGISTRY_HOST: "registry.test",
    CLICKHOUSE_URL: "http://localhost:8123",
    SESSION_SECRET: "test-user-actor-secret",
  });
});

const mocks = vi.hoisted(() => ({
  db: undefined as unknown as Record<string | symbol, unknown>,
  rbac: undefined as unknown as Record<string, (...args: any[]) => any>,
}));

vi.mock("~/mcp/confirm/storeInstance.server", () => import("./helpers/mcpConfirm"));
vi.mock("~/db.server", () => {
  const db = () => new Proxy({}, { get: (_, prop) => mocks.db[prop] });
  return {
    $replica: db(),
    prisma: db(),
    webhookPrisma: db(),
    webhookReplica: db(),
    webhookPartitionPrisma: db(),
  };
});
vi.mock("~/v3/webhookEngine.server", () => ({ webhookEngine: {} }));
vi.mock("~/services/clickhouse/clickhouseFactoryInstance.server", () => ({
  clickhouseFactory: {
    getClickhouseForOrganization: async () => {
      throw new Error("no ClickHouse in this test");
    },
  },
}));
vi.mock("~/services/rbac.server", () => ({
  rbac: new Proxy(
    {},
    {
      get:
        (_, prop: string) =>
        (...args: unknown[]) =>
          mocks.rbac[prop](...args),
    }
  ),
}));

import { resetConfirmations } from "./helpers/mcpConfirm";
import { mcpTools } from "~/mcp/registry.server";
import { mcpResource } from "~/services/oauth/metadata.server";

const project = { environment: "prod" };
const endpoint = { ...project, endpointId: "payments" };
const prompt = { ...project, slug: "my-prompt" };
const sched = { ...project, scheduleId: "sched_1" };
const errorGroup = { ...project, errorId: "error_abc123" };

const TOOLS: Array<{ tool: string; args: Record<string, unknown>; scope: string }> = [
  { tool: "get_current_worker", args: project, scope: "read:deployments" },
  { tool: "get_task_schema", args: { ...project, taskSlug: "my-task" }, scope: "read:deployments" },
  {
    tool: "wait_for_run_to_complete",
    args: { ...project, runId: "run_1", timeoutInSeconds: 1 },
    scope: "read:runs",
  },
  { tool: "list_run_tags", args: project, scope: "read:runs" },
  { tool: "read_run_stream", args: { ...project, runId: "run_1" }, scope: "read:runs" },
  { tool: "search_logs", args: project, scope: "read:runs" },
  { tool: "get_log", args: { ...project, logId: "t::s::run_1::0" }, scope: "read:runs" },
  { tool: "list_deploys", args: project, scope: "read:deployments" },
  {
    tool: "get_deployment_details",
    args: { ...project, deploymentId: "abcd1234" },
    scope: "read:deployments",
  },
  { tool: "reset_run_idempotency_key", args: { ...project, runId: "run_1" }, scope: "write:runs" },
  {
    tool: "update_run_metadata",
    args: { ...project, runId: "run_1", metadata: { a: 1 } },
    scope: "write:runs",
  },
  { tool: "add_run_tags", args: { ...project, runId: "run_1", tags: ["a"] }, scope: "write:runs" },
  {
    tool: "reschedule_run",
    args: { ...project, runId: "run_1", delay: "1h" },
    scope: "write:runs",
  },
  { tool: "list_bulk_actions", args: project, scope: "read:runs" },
  { tool: "get_bulk_action", args: { ...project, bulkActionId: "bulk_1" }, scope: "read:runs" },
  {
    tool: "create_bulk_action",
    args: { ...project, action: "cancel", runIds: ["run_1"] },
    scope: "write:runs",
  },
  { tool: "abort_bulk_action", args: { ...project, bulkActionId: "bulk_1" }, scope: "write:runs" },
  { tool: "get_query_schema", args: { ...project, table: "runs" }, scope: "read:query" },
  { tool: "list_dashboards", args: project, scope: "read:query" },
  { tool: "get_dashboard", args: { ...project, dashboardId: "dashboard_1" }, scope: "read:query" },
  { tool: "list_query_history", args: project, scope: "read:query" },
  { tool: "list_models", args: project, scope: "read:query" },
  { tool: "get_model", args: { ...project, modelId: "llm_model_1" }, scope: "read:query" },
  { tool: "get_model_usage", args: project, scope: "read:query" },
  {
    tool: "update_dashboard_widget",
    args: { ...project, dashboardId: "dashboard_1", widgetId: "w1", title: "x" },
    scope: "write:query",
  },
  {
    tool: "update_dashboard",
    args: { ...project, dashboardId: "dashboard_1", title: "x" },
    scope: "write:query",
  },
  {
    tool: "delete_dashboard",
    args: { ...project, dashboardId: "dashboard_1" },
    scope: "write:query",
  },
  { tool: "get_prompt_versions", args: prompt, scope: "read:prompts" },
  { tool: "get_prompt", args: prompt, scope: "read:prompts" },
  { tool: "list_prompt_generations", args: prompt, scope: "read:prompts" },
  { tool: "list_agents", args: project, scope: "read:deployments" },
  {
    tool: "get_agent_details",
    args: { ...project, agentSlug: "my-agent" },
    scope: "read:deployments",
  },
  {
    tool: "read_session_channel",
    args: { ...project, sessionId: "session_1" },
    scope: "read:sessions",
  },
  { tool: "list_sessions", args: project, scope: "read:sessions" },
  {
    tool: "get_session_details",
    args: { ...project, sessionId: "session_1" },
    scope: "read:sessions",
  },
  {
    tool: "read_session_transcript",
    args: { ...project, sessionId: "session_1" },
    scope: "read:sessions",
  },
  {
    tool: "list_playground_conversations",
    args: { ...project, agentSlug: "my-agent" },
    scope: "read:sessions",
  },
  { tool: "list_alert_capabilities", args: project, scope: "read:alerts" },
  { tool: "get_alert_details", args: { ...project, alertId: "alert_1" }, scope: "read:alerts" },
  { tool: "list_alert_channels", args: project, scope: "read:alerts" },
  { tool: "list_errors", args: project, scope: "read:errors" },
  { tool: "get_error_details", args: errorGroup, scope: "read:errors" },
  { tool: "resolve_error", args: errorGroup, scope: "write:errors" },
  { tool: "ignore_error", args: errorGroup, scope: "write:errors" },
  { tool: "unresolve_error", args: errorGroup, scope: "write:errors" },
  { tool: "list_webhook_endpoints", args: project, scope: "read:webhooks" },
  { tool: "get_webhook_endpoint_details", args: endpoint, scope: "read:webhooks" },
  { tool: "search_webhook_endpoints", args: project, scope: "read:webhooks" },
  { tool: "get_task_webhook", args: { ...project, taskId: "orders" }, scope: "read:webhooks" },
  { tool: "list_webhook_waiters", args: endpoint, scope: "read:webhooks" },
  { tool: "list_webhook_deliveries", args: project, scope: "read:webhooks" },
  {
    tool: "get_webhook_delivery",
    args: { ...project, deliveryId: "whd_1" },
    scope: "read:webhooks",
  },
  {
    tool: "create_alert",
    args: {
      ...project,
      capabilityKey: "queue.depth",
      params: { scope: { type: "all" } },
      condition: { kind: "threshold", operator: ">", value: 10, windowSec: 300 },
      behavior: {},
      notifiers: [{ type: "channel", channelId: "chan_1" }],
    },
    scope: "write:alerts",
  },
  {
    tool: "update_alert",
    args: { ...project, alertId: "alert_1", name: "x" },
    scope: "write:alerts",
  },
  { tool: "stop_alert", args: { ...project, alertId: "alert_1" }, scope: "write:alerts" },
  { tool: "activate_alert", args: { ...project, alertId: "alert_1" }, scope: "write:alerts" },
  { tool: "delete_alert", args: { ...project, alertId: "alert_1" }, scope: "write:alerts" },
  {
    tool: "create_alert_group",
    args: {
      ...project,
      name: "group",
      notifiers: [{ type: "channel", channelId: "chan_1" }],
      memberAlertIds: ["alert_1", "alert_2"],
    },
    scope: "write:alerts",
  },
  { tool: "ungroup_alert", args: { ...project, alertId: "alert_1" }, scope: "write:alerts" },
  { tool: "promote_prompt_version", args: { ...prompt, version: 1 }, scope: "update:prompts" },
  {
    tool: "create_prompt_override",
    args: { ...prompt, textContent: "x" },
    scope: "update:prompts",
  },
  {
    tool: "update_prompt_override",
    args: { ...prompt, textContent: "x" },
    scope: "update:prompts",
  },
  {
    tool: "reactivate_prompt_override",
    args: { ...prompt, version: 1 },
    scope: "update:prompts",
  },
  { tool: "generate_webhook_secret", args: endpoint, scope: "write:webhooks" },
  { tool: "set_webhook_secret", args: { ...endpoint, secret: "whsec_x" }, scope: "write:webhooks" },
  { tool: "remove_webhook_secret", args: endpoint, scope: "write:webhooks" },
  { tool: "generate_webhook_verify_token", args: endpoint, scope: "write:webhooks" },
  { tool: "pause_webhook_endpoint", args: endpoint, scope: "write:webhooks" },
  { tool: "resume_webhook_endpoint", args: endpoint, scope: "write:webhooks" },
  { tool: "list_tasks", args: project, scope: "read:tasks" },
  { tool: "list_schedules", args: project, scope: "read:tasks" },
  { tool: "get_schedule_details", args: sched, scope: "read:tasks" },
  {
    tool: "create_schedule",
    args: { ...project, taskId: "nightly", cron: "0 9 * * *" },
    scope: "write:tasks",
  },
  { tool: "update_schedule", args: { ...sched, cron: "0 9 * * *" }, scope: "write:tasks" },
  { tool: "activate_schedule", args: sched, scope: "write:tasks" },
  { tool: "deactivate_schedule", args: sched, scope: "write:tasks" },
  { tool: "delete_schedule", args: sched, scope: "write:tasks" },
  {
    tool: "cancel_webhook_waiter",
    args: { ...endpoint, waiterId: "waitpoint_1" },
    scope: "write:waitpoints",
  },
];

function call(name: string) {
  return mcpTools.find((t) => t.name === name)!.handler;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }) {
  return result.content.map((c) => c.text).join("\n");
}

async function pat(prisma: PrismaClient, userId: string) {
  const token = `tr_pat_${uniqueId("tok")}`;
  const row = await prisma.personalAccessToken.create({
    data: {
      name: "mcp",
      encryptedToken: {},
      obfuscatedToken: "tr_pat_****",
      hashedToken: createHash("sha256").update(token).digest("hex"),
      userId,
    },
  });
  return { id: row.id, token };
}

const bearer = (token: string) =>
  new Request("https://api.trigger.dev/mcp", { headers: { Authorization: `Bearer ${token}` } });

async function seed(prisma: PrismaClient) {
  mocks.db = prisma as unknown as Record<string | symbol, unknown>;
  mocks.rbac = plugin.create(
    { primary: prisma, replica: prisma },
    { forceFallback: true, userActorSecret: SECRET }
  ) as any;
  resetConfirmations({ autoApprove: true });

  const a = await createTestOrgProjectWithMember(prisma);
  const outsider = await createTestOrgProjectWithMember(prisma);
  await createRuntimeEnvironment(prisma, {
    projectId: a.project.id,
    organizationId: a.organization.id,
    type: "PRODUCTION",
    slug: "prod",
  });

  const outsiderPat = await pat(prisma, outsider.user.id);
  const memberPat = await pat(prisma, a.user.id);
  const withProject = (args: Record<string, unknown>) => ({
    ...args,
    projectRef: a.project.externalRef,
  });

  const outsiderCall = (tool: string, args: Record<string, unknown>) =>
    call(tool)(
      withProject(args),
      { kind: "pat", userId: outsider.user.id, tokenId: outsiderPat.id },
      bearer(outsiderPat.token)
    );

  const uatCall = async (tool: string, args: Record<string, unknown>, cap: string[]) => {
    const token = await signUserActorToken(SECRET, {
      userId: a.user.id,
      client: "mcp",
      pat: memberPat.id,
      audience: mcpResource(),
      cap,
    });
    return call(tool)(
      withProject(args),
      { kind: "uat", userId: a.user.id, sourceTokenId: memberPat.id, cap },
      bearer(token)
    );
  };

  return { outsiderCall, uatCall };
}

describe("mcp tools authorization matrix", () => {
  // Catches: a tool whose gate resolves the subject but skips the org-membership check.
  postgresTest("every tool denies a non-member of the org", async ({ prisma }) => {
    const { outsiderCall } = await seed(prisma);

    const outcomes: Record<string, string> = {};
    for (const { tool, args } of TOOLS) {
      outcomes[tool] = textOf(await outsiderCall(tool, args));
    }

    expect(outcomes).toEqual(Object.fromEntries(TOOLS.map(({ tool }) => [tool, "Not authorized"])));
  });

  // Catches: a tool gated on a different scope than its row declares, in either direction.
  postgresTest("every tool needs exactly its own scope in a uat cap", async ({ prisma }) => {
    const { uatCall } = await seed(prisma);
    const all = [...new Set(TOOLS.map((t) => t.scope))];

    const outcomes: Record<string, { own: boolean; withoutOwn: string }> = {};
    for (const { tool, args, scope } of TOOLS) {
      const own = textOf(await uatCall(tool, args, [scope]));
      const withoutOwn = textOf(
        await uatCall(
          tool,
          args,
          all.filter((s) => s !== scope)
        )
      );
      outcomes[tool] = { own: !/^(Not authorized|Insufficient scope)/.test(own), withoutOwn };
    }

    expect(outcomes).toEqual(
      Object.fromEntries(
        TOOLS.map(({ tool, scope }) => [
          tool,
          { own: true, withoutOwn: `Insufficient scope: this tool requires ${scope}` },
        ])
      )
    );
  });
});
