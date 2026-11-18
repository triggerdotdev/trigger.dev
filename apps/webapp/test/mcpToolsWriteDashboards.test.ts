import { postgresTest } from "@internal/testcontainers";
import plugin from "@trigger.dev/rbac";
import type { PrismaClient } from "@trigger.dev/database";
import { createHash } from "node:crypto";
import { describe, expect, vi } from "vitest";
import {
  createRuntimeEnvironment,
  createTestOrgProjectWithMember,
  uniqueId,
} from "./fixtures/environmentVariablesFixtures";

vi.setConfig({ testTimeout: 60_000 });

const mocks = vi.hoisted(() => {
  Object.assign(process.env, {
    DATABASE_URL: "postgresql://u:p@localhost:5432/db",
    DIRECT_URL: "postgresql://u:p@localhost:5432/db",
    MAGIC_LINK_SECRET: "test-magic-link-secret",
    ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
    DEPLOY_REGISTRY_HOST: "registry.test",
    V4_DEPLOY_REGISTRY_HOST: "registry.test",
    CLICKHOUSE_URL: "http://localhost:8123",
  });
  return {
    db: undefined as unknown as Record<string | symbol, unknown>,
    rbac: undefined as unknown as Record<string, (...args: any[]) => any>,
  };
});

vi.mock("~/mcp/confirm/storeInstance.server", () => import("./helpers/mcpConfirm"));
vi.mock("~/db.server", () => ({
  $replica: new Proxy({}, { get: (_, prop) => mocks.db[prop] }),
  prisma: new Proxy({}, { get: (_, prop) => mocks.db[prop] }),
  $transaction: (client: any, _name: string, fn: (tx: unknown) => Promise<unknown>) =>
    client.$transaction(fn),
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

import type { McpIdentity } from "~/mcp/types";
import {
  expectPending,
  getMcpConfirmationStore,
  pending,
  resetConfirmations,
} from "./helpers/mcpConfirm";
import { dashboardsWriteTools } from "~/mcp/tools/dashboardsWrite.server";
import { promptsWriteTools } from "~/mcp/tools/promptsWrite.server";

function tool(tools: { name: string; handler: Function }[], name: string) {
  return tools.find((t) => t.name === name)!.handler as (
    args: unknown,
    identity: McpIdentity,
    request: Request
  ) => Promise<{ isError?: boolean; content: { text: string }[] }>;
}

async function seed(prisma: PrismaClient) {
  mocks.db = prisma as unknown as Record<string | symbol, unknown>;
  mocks.rbac = plugin.create({ primary: prisma, replica: prisma }, { forceFallback: true }) as any;
  resetConfirmations({ autoApprove: true });

  const a = await createTestOrgProjectWithMember(prisma);
  const b = await createTestOrgProjectWithMember(prisma);
  const env = await createRuntimeEnvironment(prisma, {
    projectId: a.project.id,
    organizationId: a.organization.id,
    type: "PRODUCTION",
    slug: "prod",
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

  const dashboard = await prisma.metricsDashboard.create({
    data: {
      friendlyId: uniqueId("dash"),
      title: "Seeded Dashboard",
      organizationId: a.organization.id,
      projectId: a.project.id,
      layout: JSON.stringify({
        version: "1",
        layout: [{ i: "old", x: 0, y: 0, w: 12, h: 4 }],
        widgets: { old: { title: "Old widget", query: "", display: { type: "title" } } },
      }),
    },
  });

  const prompt = await prisma.prompt.create({
    data: {
      friendlyId: uniqueId("prompt"),
      slug: "greeter",
      organizationId: a.organization.id,
      projectId: a.project.id,
      runtimeEnvironmentId: env.id,
    },
  });
  for (const version of [1, 2]) {
    await prisma.promptVersion.create({
      data: {
        promptId: prompt.id,
        version,
        source: "code",
        textContent: `hello v${version}`,
        contentHash: `hash-${version}`,
        labels: version === 2 ? ["current"] : [],
      },
    });
  }

  const bEnv = await createRuntimeEnvironment(prisma, {
    projectId: b.project.id,
    organizationId: b.organization.id,
    type: "PRODUCTION",
    slug: "prod",
  });
  const bPrompt = await prisma.prompt.create({
    data: {
      friendlyId: uniqueId("prompt"),
      slug: "greeter",
      organizationId: b.organization.id,
      projectId: b.project.id,
      runtimeEnvironmentId: bEnv.id,
    },
  });
  await prisma.promptVersion.create({
    data: {
      promptId: bPrompt.id,
      version: 1,
      source: "dashboard",
      textContent: "b override",
      contentHash: "hash-b",
      labels: ["override"],
    },
  });
  const bDashboard = await prisma.metricsDashboard.create({
    data: {
      friendlyId: uniqueId("dash"),
      title: "B Dashboard",
      organizationId: b.organization.id,
      projectId: b.project.id,
      layout: JSON.stringify({
        version: "1",
        layout: [{ i: "keep", x: 0, y: 0, w: 12, h: 4 }],
        widgets: { keep: { title: "Keep", query: "", display: { type: "title" } } },
      }),
    },
  });

  return { a, b, identity, request, dashboard, prompt, bPrompt, bDashboard };
}

const base = (projectRef: string) => ({ projectRef, environment: "prod" as const });

describe("MCP dashboard and prompt write tools", () => {
  postgresTest(
    "create_dashboard creates a row scoped to the gate-resolved org and project",
    async ({ prisma }) => {
      const { a, b, identity, request } = await seed(prisma);

      const result = await tool(dashboardsWriteTools, "create_dashboard")(
        {
          ...base(a.project.externalRef),
          title: "Fresh",
          organizationId: b.organization.id,
          projectId: b.project.id,
        },
        identity,
        request
      );

      expect(result.isError).toBeUndefined();
      const row = await prisma.metricsDashboard.findFirstOrThrow({ where: { title: "Fresh" } });
      expect(row.organizationId).toBe(a.organization.id);
      expect(row.projectId).toBe(a.project.id);
      expect(result.content[0]!.text).toContain(row.friendlyId);
    }
  );

  // Catches: a write running before approval, or an approval unlocking different args.
  postgresTest("create_dashboard waits for approval of the exact call", async ({ prisma }) => {
    const { a, identity, request } = await seed(prisma);
    resetConfirmations({ autoApprove: false });
    const create = tool(dashboardsWriteTools, "create_dashboard");
    const args = { ...base(a.project.externalRef), title: "Gated" };
    const count = () =>
      prisma.metricsDashboard.count({ where: { title: { startsWith: "Gated" } } });

    const id = await expectPending(create(args, identity, request));
    expect(await count()).toBe(0);
    expect(await getMcpConfirmationStore().approve(id, identity.userId)).toBe(true);

    await expectPending(create({ ...args, title: "Gated 2" }, identity, request));
    expect((await create(args, identity, request)).isError).toBeUndefined();
    expect(await count()).toBe(1);
    expect(pending()).toHaveLength(1);
  });

  postgresTest("set_dashboard_widgets replaces the widgets", async ({ prisma }) => {
    const { a, identity, request, dashboard } = await seed(prisma);

    const result = await tool(dashboardsWriteTools, "set_dashboard_widgets")(
      {
        ...base(a.project.externalRef),
        dashboardId: dashboard.friendlyId,
        widgets: [{ id: "fresh", title: "Fresh widget", display: { type: "title" } }],
      },
      identity,
      request
    );

    expect(result.isError).toBeUndefined();
    const row = await prisma.metricsDashboard.findFirstOrThrow({ where: { id: dashboard.id } });
    expect(Object.keys((JSON.parse(row.layout as string) as { widgets: object }).widgets)).toEqual([
      "fresh",
    ]);
  });

  postgresTest("promote_prompt_version changes the active version", async ({ prisma }) => {
    const { a, identity, request, prompt } = await seed(prisma);

    const result = await tool(promptsWriteTools, "promote_prompt_version")(
      { ...base(a.project.externalRef), slug: "greeter", version: 1 },
      identity,
      request
    );

    expect(result.content[0]!.text).toBe('Promoted "greeter" v1 to current.');
    const current = await prisma.promptVersion.findMany({
      where: { promptId: prompt.id, labels: { has: "current" } },
    });
    expect(current.map((v) => v.version)).toEqual([1]);
  });

  postgresTest("create_prompt_override stores source mcp", async ({ prisma }) => {
    const { a, identity, request, prompt } = await seed(prisma);

    const result = await tool(promptsWriteTools, "create_prompt_override")(
      { ...base(a.project.externalRef), slug: "greeter", textContent: "override" },
      identity,
      request
    );

    expect(result.content[0]!.text).toBe('Created override for "greeter" as v3.');
    const version = await prisma.promptVersion.findFirstOrThrow({
      where: { promptId: prompt.id, version: 3 },
    });
    expect(version.source).toBe("mcp");
  });

  postgresTest(
    "remove_prompt_override is denied for a non-member projectRef",
    async ({ prisma }) => {
      const { b, identity, request, bPrompt } = await seed(prisma);

      const result = await tool(promptsWriteTools, "remove_prompt_override")(
        { ...base(b.project.externalRef), slug: "greeter" },
        identity,
        request
      );

      expect(result).toMatchObject({ isError: true, content: [{ text: "Not authorized" }] });
      const labels = await prisma.promptVersion.findFirstOrThrow({
        where: { promptId: bPrompt.id },
      });
      expect(labels.labels).toEqual(["override"]);
    }
  );

  postgresTest(
    "set_dashboard_widgets cannot replace a dashboard of another org",
    async ({ prisma }) => {
      const { a, identity, request, bDashboard } = await seed(prisma);

      const result = await tool(dashboardsWriteTools, "set_dashboard_widgets")(
        {
          ...base(a.project.externalRef),
          dashboardId: bDashboard.friendlyId,
          widgets: [{ id: "evil", title: "Evil", display: { type: "title" } }],
        },
        identity,
        request
      );

      expect(result.isError).toBe(true);
      const row = await prisma.metricsDashboard.findFirstOrThrow({ where: { id: bDashboard.id } });
      expect(row.layout).toBe(bDashboard.layout);
    }
  );

  postgresTest("override update, remove and reactivate succeed in sequence", async ({ prisma }) => {
    const { a, identity, request, prompt } = await seed(prisma);
    const args = { ...base(a.project.externalRef), slug: "greeter" };
    const call = (name: string, extra: object) =>
      tool(promptsWriteTools, name)({ ...args, ...extra }, identity, request);

    await call("create_prompt_override", { textContent: "first" });
    const updated = await call("update_prompt_override", { textContent: "second" });
    const removed = await call("remove_prompt_override", {});
    const reactivated = await call("reactivate_prompt_override", { version: 3 });

    expect([updated, removed, reactivated].map((r) => [r.isError, r.content[0]!.text])).toEqual([
      [undefined, 'Updated override for "greeter".'],
      [undefined, 'Removed override for "greeter".'],
      [undefined, 'Reactivated v3 as override for "greeter".'],
    ]);
    const v3 = await prisma.promptVersion.findFirstOrThrow({
      where: { promptId: prompt.id, version: 3 },
    });
    expect(v3.labels).toEqual(["override"]);
  });
});
