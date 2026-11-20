import { postgresTest } from "@internal/testcontainers";
import plugin, { signUserActorToken } from "@trigger.dev/rbac";
import type { PrismaClient } from "@trigger.dev/database";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
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
    SESSION_SECRET: "test-user-actor-secret",
    ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
    DEPLOY_REGISTRY_HOST: "registry.test",
    V4_DEPLOY_REGISTRY_HOST: "registry.test",
    CLICKHOUSE_URL: "http://localhost:8123",
  });
});

const mocks = vi.hoisted(() => ({
  db: undefined as unknown as Record<string | symbol, unknown>,
  rbac: undefined as unknown as Record<string, (...args: any[]) => any>,
}));

vi.mock("~/mcp/confirm/storeInstance.server", () => import("./helpers/mcpConfirm"));
vi.mock("~/db.server", () => ({
  $replica: new Proxy({}, { get: (_, prop) => mocks.db[prop] }),
  prisma: new Proxy({}, { get: (_, prop) => mocks.db[prop] }),
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

import type { McpToolDefinition } from "~/mcp/registry.server";
import {
  expectPending,
  getMcpConfirmationStore,
  pending,
  resetConfirmations,
} from "./helpers/mcpConfirm";
import type { McpIdentity } from "~/mcp/types";
import { mcpResource } from "~/services/oauth/metadata.server";
import { orgsWriteTools } from "~/mcp/tools/orgsWrite.server";
import { createRunsWriteTools } from "~/mcp/tools/runsWrite.server";
import { createTasksWriteTools } from "~/mcp/tools/tasksWrite.server";
import { sanitizeTriggerSource } from "~/utils/triggerSource";

function tool(tools: McpToolDefinition[], name: string) {
  return tools.find((t) => t.name === name)!.handler;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }) {
  return result.content.map((c) => c.text).join("\n");
}

async function seed(prisma: PrismaClient) {
  mocks.db = prisma as unknown as Record<string | symbol, unknown>;
  mocks.rbac = plugin.create(
    { primary: prisma, replica: prisma },
    { forceFallback: true, userActorSecret: SECRET }
  ) as any;
  resetConfirmations({ autoApprove: true });

  const a = await createTestOrgProjectWithMember(prisma);
  const b = await createTestOrgProjectWithMember(prisma);
  const environment = await createRuntimeEnvironment(prisma, {
    projectId: a.project.id,
    organizationId: a.organization.id,
    type: "PRODUCTION",
    slug: "prod",
  });
  await createRuntimeEnvironment(prisma, {
    projectId: b.project.id,
    organizationId: b.organization.id,
    type: "PRODUCTION",
    slug: "prod",
  });

  const run = await prisma.taskRun.create({
    data: {
      friendlyId: uniqueId("run"),
      taskIdentifier: "my-task",
      payload: "{}",
      payloadType: "application/json",
      traceId: uniqueId("trace"),
      spanId: uniqueId("span"),
      queue: "task/my-task",
      runtimeEnvironmentId: environment.id,
      environmentType: "PRODUCTION",
      projectId: a.project.id,
      organizationId: a.organization.id,
      status: "EXECUTING",
    },
  });

  const pat = `tr_pat_${uniqueId("tok")}`;
  const token = await prisma.personalAccessToken.create({
    data: {
      id: "pat_src",
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
  const scope = { projectRef: a.project.externalRef, environment: "prod" };

  return { a, b, environment, run, identity, request, scope };
}

describe("mcp write tools", () => {
  // Catches: a client claiming the hosted server's source through the header.
  it.each([
    ["mcp", "mcp"],
    ["mcp-remote", undefined],
  ])("trigger source header %s is read as %s", (header, expected) => {
    expect(sanitizeTriggerSource(header)).toBe(expected);
  });

  postgresTest("cancel_run cancels through the service and reports the run", async ({ prisma }) => {
    const { environment, run, identity, request, scope } = await seed(prisma);
    const cancelRun = vi.fn(async (_env: unknown, runId: string) => {
      await prisma.taskRun.update({ where: { friendlyId: runId }, data: { status: "CANCELED" } });
      return "canceled" as const;
    });

    const text = textOf(
      await tool(createRunsWriteTools({ cancelRun }), "cancel_run")(
        { ...scope, runId: run.friendlyId },
        identity,
        request
      )
    );

    expect(cancelRun).toHaveBeenCalledWith(
      expect.objectContaining({ id: environment.id }),
      run.friendlyId
    );
    expect(text).toContain(`Run ${run.friendlyId} canceled.`);
    expect(text).toContain("Status: CANCELED");
    expect(text).toContain("Task: my-task");
  });

  // Catches: replay_run passing the local CLI source (mcp) instead of mcp-remote to the replay function.
  postgresTest(
    "replay_run replays through the service and reports the new run",
    async ({ prisma }) => {
      const { run, identity, request, scope } = await seed(prisma);
      const replayRun = vi.fn(async () => ({ id: "run_replayed" }));

      const text = textOf(
        await tool(createRunsWriteTools({ replayRun }), "replay_run")(
          { ...scope, runId: run.friendlyId, tags: ["a"] },
          identity,
          request
        )
      );

      expect(replayRun).toHaveBeenCalledWith(
        expect.objectContaining({ id: run.id }),
        expect.objectContaining({ tags: ["a"] }),
        "mcp-remote"
      );
      expect(text).toContain(`Run ${run.friendlyId} replayed as run_replayed.`);
    }
  );

  // Catches: dropping the per-task trigger check, so write:runs alone could replay.
  postgresTest("replay_run requires trigger permission on the run's task", async ({ prisma }) => {
    const { a, run, scope } = await seed(prisma);
    const replayRun = vi.fn(async () => ({ id: "run_replayed" }));
    const replay = tool(createRunsWriteTools({ replayRun }), "replay_run");

    const call = async (cap: string[]) => {
      const token = await signUserActorToken(SECRET, {
        userId: a.user.id,
        client: "mcp",
        pat: "pat_src",
        cap,
        audience: mcpResource(),
      });
      const identity: McpIdentity = {
        kind: "uat",
        userId: a.user.id,
        sourceTokenId: "pat_src",
        cap,
      };
      const request = new Request("https://api.trigger.dev/mcp", {
        headers: { Authorization: `Bearer ${token}` },
      });
      return replay({ ...scope, runId: run.friendlyId }, identity, request);
    };

    const denied = await call(["write:runs"]);
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toContain("permission to trigger the my-task task");
    expect(replayRun).not.toHaveBeenCalled();

    expect(textOf(await call(["write:runs", "trigger:tasks"]))).toContain(
      "replayed as run_replayed"
    );
    expect(replayRun).toHaveBeenCalledTimes(1);
  });

  // Catches: a write running before approval, or an approval unlocking different args.
  postgresTest("cancel_run waits for approval of the exact call", async ({ prisma }) => {
    const { run, identity, request, scope } = await seed(prisma);
    resetConfirmations({ autoApprove: false });
    const cancelRun = vi.fn(async () => "canceled" as const);
    const cancel = tool(createRunsWriteTools({ cancelRun }), "cancel_run");
    const args = { ...scope, runId: run.friendlyId };

    const id = await expectPending(cancel(args, identity, request));
    expect(cancelRun).not.toHaveBeenCalled();
    expect(await getMcpConfirmationStore().approve(id, identity.userId)).toBe(true);

    await expectPending(cancel({ ...args, runId: "run_other" }, identity, request));
    expect((await cancel(args, identity, request)).isError).toBeUndefined();
    expect(cancelRun).toHaveBeenCalledTimes(1);
    expect(pending()).toHaveLength(1);
  });

  postgresTest("cancel_run denies a project the user is not a member of", async ({ prisma }) => {
    const { b, run, identity, request, scope } = await seed(prisma);
    const cancelRun = vi.fn();

    const result = await tool(createRunsWriteTools({ cancelRun }), "cancel_run")(
      { ...scope, projectRef: b.project.externalRef, runId: run.friendlyId },
      identity,
      request
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("Not authorized");
    expect(cancelRun).not.toHaveBeenCalled();
  });

  postgresTest(
    "create_project_in_org rejects an org the user is not a member of",
    async ({ prisma }) => {
      const { b, identity, request } = await seed(prisma);
      const before = await prisma.project.count();

      const result = await tool(orgsWriteTools, "create_project_in_org")(
        { orgParam: b.organization.slug, name: "intruder" },
        identity,
        request
      );

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Organization not found");
      expect(await prisma.project.count()).toBe(before);
    }
  );

  // Catches: a user-actor token creating a project without write:projects in its cap.
  postgresTest(
    "create_project_in_org needs write:projects for a user-actor token",
    async ({ prisma }) => {
      const { a, identity, request } = await seed(prisma);
      const create = tool(orgsWriteTools, "create_project_in_org");
      const asUat = async (cap: string[], name: string) => {
        const token = await signUserActorToken(SECRET, {
          userId: a.user.id,
          client: "mcp",
          pat: "pat_src",
          cap,
          audience: mcpResource(),
        });
        const uat: McpIdentity = {
          kind: "uat",
          userId: a.user.id,
          sourceTokenId: "pat_src",
          cap,
        };
        const request = new Request("https://api.trigger.dev/mcp", {
          headers: { Authorization: `Bearer ${token}` },
        });
        return create({ orgParam: a.organization.slug, name }, uat, request);
      };
      await prisma.organization.update({
        where: { id: a.organization.id },
        data: { isActivated: true },
      });
      const projects = () => prisma.project.count({ where: { organizationId: a.organization.id } });
      const before = await projects();

      const denied = await asUat(["read:all"], "capped");
      expect(textOf(denied)).toBe("Insufficient scope: this tool requires write:projects");
      expect(await projects()).toBe(before);

      const allowed = await asUat(["write:projects"], "capped-ok");
      expect(textOf(allowed)).toContain("Project created successfully: capped-ok");
      expect(await projects()).toBe(before + 1);

      const created = await create(
        { orgParam: a.organization.slug, name: "member" },
        identity,
        request
      );
      expect(textOf(created)).toContain("Project created successfully: member");
      expect(await projects()).toBe(before + 2);
    }
  );

  // Catches: trigger_task passing the local CLI source (mcp) instead of mcp-remote to the trigger function.
  postgresTest(
    "trigger_task parses a JSON-string payload and returns the run",
    async ({ prisma }) => {
      const { environment, identity, request, scope } = await seed(prisma);
      const triggerTask = vi.fn(async () => ({ id: "run_new" }));

      const text = textOf(
        await tool(createTasksWriteTools({ triggerTask }), "trigger_task")(
          { ...scope, taskId: "my-task", payload: '{"email":"a@b.c"}' },
          identity,
          request
        )
      );

      expect(triggerTask).toHaveBeenCalledWith(
        "my-task",
        expect.objectContaining({ id: environment.id }),
        expect.objectContaining({ payload: { email: "a@b.c" } }),
        "mcp-remote"
      );
      expect(text).toContain("Task my-task triggered and run with ID created: run_new.");
    }
  );

  // Catches: dropping the per-task trigger check, so any trigger:tasks:<other> cap could trigger.
  postgresTest("trigger_task requires trigger permission on that task", async ({ prisma }) => {
    const { a, scope } = await seed(prisma);
    const triggerTask = vi.fn(async () => ({ id: "run_new" }));
    const trigger = tool(createTasksWriteTools({ triggerTask }), "trigger_task");

    const call = async (cap: string[]) => {
      const token = await signUserActorToken(SECRET, {
        userId: a.user.id,
        client: "mcp",
        pat: "pat_src",
        cap,
        audience: mcpResource(),
      });
      const identity: McpIdentity = {
        kind: "uat",
        userId: a.user.id,
        sourceTokenId: "pat_src",
        cap,
      };
      const request = new Request("https://api.trigger.dev/mcp", {
        headers: { Authorization: `Bearer ${token}` },
      });
      return trigger({ ...scope, taskId: "my-task", payload: {} }, identity, request);
    };

    const denied = await call(["trigger:tasks:other"]);
    expect(denied.isError).toBe(true);
    expect(triggerTask).not.toHaveBeenCalled();

    expect(textOf(await call(["trigger:tasks"]))).toContain("ID created: run_new");
    expect(triggerTask).toHaveBeenCalledTimes(1);
  });

  // Catches: dropping the resource id from the gate, so a per-task grant never matches.
  postgresTest(
    "trigger_task passes the gate with a cap scoped to that task id",
    async ({ prisma }) => {
      const { a, scope } = await seed(prisma);
      const triggerTask = vi.fn(async () => ({ id: "run_new" }));
      const trigger = tool(createTasksWriteTools({ triggerTask }), "trigger_task");
      const cap = ["trigger:tasks:my-task"];
      const token = await signUserActorToken(SECRET, {
        userId: a.user.id,
        client: "mcp",
        pat: "pat_src",
        audience: mcpResource(),
        cap,
      });
      const identity: McpIdentity = {
        kind: "uat",
        userId: a.user.id,
        sourceTokenId: "pat_src",
        cap,
      };
      const request = new Request("https://api.trigger.dev/mcp", {
        headers: { Authorization: `Bearer ${token}` },
      });

      const allowed = await trigger(
        { ...scope, taskId: "my-task", payload: {} },
        identity,
        request
      );
      expect(textOf(allowed)).toContain("ID created: run_new");

      const denied = await trigger(
        { ...scope, taskId: "other-task", payload: {} },
        identity,
        request
      );
      expect(denied.isError).toBe(true);
      expect(textOf(denied)).toBe("Insufficient scope: this tool requires trigger:tasks");
      expect(triggerTask).toHaveBeenCalledTimes(1);
    }
  );

  postgresTest("trigger_task rejects invalid arguments before triggering", async ({ prisma }) => {
    const { identity, request, scope } = await seed(prisma);
    const triggerTask = vi.fn();

    const result = await tool(createTasksWriteTools({ triggerTask }), "trigger_task")(
      { ...scope, taskId: "my-task", payload: {}, options: { maxAttempts: "many" } },
      identity,
      request
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Invalid arguments");
    expect(triggerTask).not.toHaveBeenCalled();
  });
});
