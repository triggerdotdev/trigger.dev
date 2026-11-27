import { postgresTest } from "@internal/testcontainers";
import plugin, { signUserActorToken } from "@trigger.dev/rbac";
import type { PrismaClient, RuntimeEnvironmentType } from "@trigger.dev/database";
import { createHash } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, describe, expect, vi } from "vitest";
import {
  createRuntimeEnvironment,
  createTestOrgProjectWithMember,
  uniqueId,
} from "./fixtures/environmentVariablesFixtures";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const hoisted = await vi.hoisted(async () => {
  Object.assign(process.env, {
    DATABASE_URL: "postgresql://unused:unused@localhost:5432/unused",
    DIRECT_URL: "postgresql://unused:unused@localhost:5432/unused",
    MAGIC_LINK_SECRET: "magic-link-secret-for-tests",
    SESSION_SECRET: "test-user-actor-secret",
    ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
    DEPLOY_REGISTRY_HOST: "registry.test",
    V4_DEPLOY_REGISTRY_HOST: "registry.test",
    CLICKHOUSE_URL: "http://localhost:8123",
    COMMON_WORKER_ENABLED: "false",
    RUN_ENGINE_RUN_QUEUE_SHARD_COUNT: "4",
    RUN_ENGINE_WORKER_ENABLED: "0",
    BATCH_QUEUE_WORKER_ENABLED: "false",
  });
  const { createRedisContainer } =
    await import("../../../internal-packages/testcontainers/src/utils");
  const { container } = await createRedisContainer({});
  const { pointAllRedisAt } = await import("./helpers/redisEnv");
  pointAllRedisAt(container.getHost(), container.getPort());
  return {
    container,
    mocks: {
      db: undefined as unknown as Record<string | symbol, unknown>,
      rbac: undefined as unknown as Record<string, (...args: any[]) => any>,
    },
  };
});

vi.unmock("~/v3/runEngine.server");
vi.mock("~/mcp/confirm/storeInstance.server", () => import("./helpers/mcpConfirm"));
vi.mock("~/db.server", async () => {
  const { Prisma, boundedIn } = await import("@trigger.dev/database");
  const db = new Proxy(
    {},
    { get: (_, prop) => hoisted.mocks.db[prop], has: (_, prop) => prop in hoisted.mocks.db }
  );
  return {
    Prisma,
    boundedIn,
    sqlDatabaseSchema: Prisma.sql([`public`]),
    runOpsSplitReadEnabled: false,
    runOpsShardHandles: [],
    $transaction: (
      client: PrismaClient,
      fnOrName: string | Parameters<PrismaClient["$transaction"]>[0],
      fnOrOptions?: Parameters<PrismaClient["$transaction"]>[0] | object,
      options?: object
    ) =>
      typeof fnOrName === "string"
        ? client.$transaction(fnOrOptions as never, options)
        : client.$transaction(fnOrName as never, fnOrOptions as object | undefined),
    $replica: db,
    prisma: db,
    runOpsNewPrisma: db,
    runOpsNewReplica: db,
    runOpsLegacyPrisma: db,
    runOpsLegacyReplica: db,
    runOpsNewPrismaClient: db,
    runOpsNewReplicaClient: db,
    runOpsLegacyPrismaClient: db,
    runOpsLegacyReplicaClient: db,
    webhookPrisma: db,
    webhookReplica: db,
    webhookPartitionPrisma: db,
  };
});
vi.mock("~/services/rbac.server", () => ({
  rbac: new Proxy(
    {},
    {
      get:
        (_, prop: string) =>
        (...args: unknown[]) =>
          hoisted.mocks.rbac[prop](...args),
    }
  ),
}));

import { $transaction } from "~/db.server";
import type { McpIdentity } from "~/mcp/types";
import { projectsWriteTools } from "~/mcp/tools/projectsWrite.server";
import { mcpResource } from "~/services/oauth/metadata.server";
import { engine } from "~/v3/runEngine.server";
import { approveAll, pending, resetConfirmations } from "./helpers/mcpConfirm";

const redis = new Redis({ host: hoisted.container.getHost(), port: hoisted.container.getPort() });

afterAll(async () => {
  await engine.quit();
  redis.disconnect();
  await hoisted.container.stop();
});

const STALE =
  "What this change would do has changed since it was approved. Call the tool again to get a new confirmation.";

const textOf = (result: { content: Array<{ type: string; text?: string }> }) =>
  result.content.map((c) => c.text).join("\n");

/** Runs `action` while a rival rename holds the project row, and commits the rival once `action` waits on it. */
async function duringRivalRename<T>(
  prisma: PrismaClient,
  projectId: string,
  action: () => Promise<T>
) {
  const started = Promise.withResolvers<number>();
  const release = Promise.withResolvers<void>();
  const rival = $transaction(
    prisma,
    "rival rename",
    async (tx) => {
      await tx.project.update({ where: { id: projectId }, data: { name: "Theirs" } });
      const [{ pid }] = await tx.$queryRaw<[{ pid: number }]>`SELECT pg_backend_pid() AS pid`;
      started.resolve(pid);
      await release.promise;
    },
    { timeout: 30_000 }
  );
  const pid = await started.promise;
  const acting = action();
  const deadline = Date.now() + 15_000;
  while (true) {
    const [{ waiting }] = await prisma.$queryRaw<[{ waiting: number }]>`
      SELECT count(*)::int AS waiting FROM pg_stat_activity
      WHERE wait_event_type = 'Lock' AND ${pid}::int = ANY(pg_blocking_pids(pid))`;
    if (waiting > 0) break;
    if (Date.now() > deadline) throw new Error("the action never waited on the rival");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  release.resolve();
  await rival;
  return acting;
}

/** Every queue of the project still listed on a master queue shard. */
async function masterQueueMembers(projectId: string) {
  const shards = await redis.keys("*masterQueue*");
  const members = (await Promise.all(shards.map((key) => redis.zrange(key, 0, -1)))).flat();
  return members.filter((member) => member.includes(projectId));
}

async function seed(prisma: PrismaClient) {
  hoisted.mocks.db = prisma as unknown as Record<string | symbol, unknown>;
  hoisted.mocks.rbac = plugin.create(
    { primary: prisma, replica: prisma },
    { forceFallback: true, userActorSecret: process.env.SESSION_SECRET }
  ) as any;
  resetConfirmations({ autoApprove: false });

  const a = await createTestOrgProjectWithMember(prisma);
  const b = await createTestOrgProjectWithMember(prisma);
  const env = (type: "PRODUCTION" | "PREVIEW" | "DEVELOPMENT", slug: string) =>
    createRuntimeEnvironment(prisma, {
      projectId: a.project.id,
      organizationId: a.organization.id,
      type,
      slug,
    });
  const prod = await env("PRODUCTION", "prod");
  const preview = await env("PREVIEW", "preview");
  const dev = await env("DEVELOPMENT", "dev");
  for (const parent of [preview, dev]) {
    await prisma.runtimeEnvironment.create({
      data: {
        slug: uniqueId("branch"),
        shortcode: uniqueId("sc"),
        apiKey: uniqueId("api"),
        pkApiKey: uniqueId("pk"),
        type: parent.type,
        branchName: `feature-${parent.type.toLowerCase()}`,
        parentEnvironmentId: parent.id,
        projectId: a.project.id,
        organizationId: a.organization.id,
      },
    });
  }

  const pat = async (userId: string) => {
    const secret = `tr_pat_${uniqueId("tok")}`;
    const token = await prisma.personalAccessToken.create({
      data: {
        name: "mcp",
        encryptedToken: {},
        obfuscatedToken: "tr_pat_****",
        hashedToken: createHash("sha256").update(secret).digest("hex"),
        userId,
      },
    });
    return { id: token.id, secret };
  };
  const member = await pat(a.user.id);
  const identity: McpIdentity = { kind: "pat", userId: a.user.id, tokenId: member.id };
  const bearer = (token: string) =>
    new Request("https://api.trigger.dev/mcp", { headers: { Authorization: `Bearer ${token}` } });

  const tool = (name: string) => projectsWriteTools.find((t) => t.name === name)!;
  const call = (name: string, args: object = {}) =>
    tool(name).handler(
      { projectRef: a.project.externalRef, ...args },
      identity,
      bearer(member.secret)
    );

  const uatCall = async (
    name: string,
    args: object,
    scope: { cap: string[]; organizationId?: string; environmentId?: string }
  ) => {
    const jwt = await signUserActorToken(process.env.SESSION_SECRET!, {
      userId: a.user.id,
      client: "mcp",
      pat: member.id,
      audience: mcpResource(),
      ...scope,
    });
    return tool(name).handler(
      { projectRef: a.project.externalRef, ...args },
      { kind: "uat", userId: a.user.id, sourceTokenId: member.id, ...scope },
      bearer(jwt)
    );
  };

  const held = async (pendingCall: () => Promise<unknown>) => {
    resetConfirmations({ autoApprove: false });
    await expect(pendingCall()).rejects.toThrow();
    const [record] = pending();
    return record!.preview;
  };

  const refusedBeforeConfirm = async (name: string, args: object) => {
    resetConfirmations({ autoApprove: false });
    const result = await call(name, args);
    return { isError: result.isError, pending: pending().length, text: textOf(result) };
  };

  const schedule = (environmentId: string = prod.id) =>
    prisma.taskSchedule.create({
      data: {
        friendlyId: uniqueId("sched"),
        projectId: a.project.id,
        taskIdentifier: "nightly",
        generatorExpression: "0 9 * * *",
        instances: { create: { environmentId, projectId: a.project.id, schedulePhase: 0 } },
      },
    });

  const engineEnv = (environment: { id: string; type: RuntimeEnvironmentType }) => ({
    id: environment.id,
    type: environment.type,
    maximumConcurrencyLimit: 10,
    concurrencyLimitBurstFactor: 2,
    project: { id: a.project.id },
    organization: { id: a.organization.id },
  });
  const prodEnv = engineEnv(prod);
  const enqueueRun = (environment: { id: string; type: RuntimeEnvironmentType } = prod) =>
    engine.runQueue.enqueueMessage({
      env: engineEnv(environment),
      message: {
        runId: uniqueId("run"),
        orgId: a.organization.id,
        projectId: a.project.id,
        environmentId: environment.id,
        environmentType: environment.type,
        queue: "task/nightly",
        timestamp: Date.now(),
        attempt: 0,
      },
      workerQueue: "main",
      skipDequeueProcessing: true,
    });

  const project = () => prisma.project.findFirstOrThrow({ where: { id: a.project.id } });

  return {
    a,
    b,
    prod,
    preview,
    pat,
    bearer,
    tool,
    call,
    uatCall,
    held,
    refusedBeforeConfirm,
    schedule,
    enqueueRun,
    prodEnv,
    project,
  };
}

describe("rename_project", () => {
  // Catches: the rename writing the slug or ref, or the approved rename not landing.
  postgresTest("renames after approval and keeps the ref and slug", async ({ prisma }) => {
    const { a, call, held, project } = await seed(prisma);

    const preview = await held(() => call("rename_project", { name: "  Billing jobs  " }));
    await approveAll();
    const result = await call("rename_project", { name: "  Billing jobs  " });

    expect(preview.split("\n")[0]).toBe(
      'Rename project "Test Project" to "Billing jobs" in organization "Test Org".'
    );
    expect(result.isError).toBeUndefined();
    expect(await project()).toMatchObject({
      name: "Billing jobs",
      slug: a.project.slug,
      externalRef: a.project.externalRef,
    });
  });

  // Catches: an invalid or unchanged name reaching the confirmation page.
  postgresTest("refuses invalid and unchanged names before confirmation", async ({ prisma }) => {
    const { refusedBeforeConfirm, project } = await seed(prisma);

    const outcomes = [];
    for (const name of ["ab", "  ab  ", "x".repeat(51), " Test Project "]) {
      outcomes.push(await refusedBeforeConfirm("rename_project", { name }));
    }

    expect(outcomes.map(({ isError, pending }) => ({ isError, pending }))).toEqual(
      Array(4).fill({ isError: true, pending: 0 })
    );
    expect(outcomes[3]!.text).toContain("already named");
    expect((await project()).name).toBe("Test Project");
  });

  // Catches: the 3–50 limit applied to the untrimmed name.
  postgresTest("measures the trimmed name", async ({ prisma }) => {
    const { call, held } = await seed(prisma);

    const preview = await held(() => call("rename_project", { name: ` ${"x".repeat(50)} ` }));

    expect(preview.split("\n")[0]).toContain(`to "${"x".repeat(50)}"`);
  });

  // Catches: the rename not bound to the project's revision, so a rival rename is overwritten.
  postgresTest("refuses when the project is renamed while it runs", async ({ prisma }) => {
    const { a, call, held, project } = await seed(prisma);
    await held(() => call("rename_project", { name: "Mine" }));
    await approveAll();

    const result = await duringRivalRename(prisma, a.project.id, () =>
      call("rename_project", { name: "Mine" })
    );

    expect({ text: textOf(result), name: (await project()).name }).toEqual({
      text: STALE,
      name: "Theirs",
    });
  });
});

describe("delete_project", () => {
  // Catches: a preview missing a counted fact, or the delete not removing the queues or not marking the project.
  postgresTest("shows the counted facts, then deletes after approval", async ({ prisma }) => {
    const { a, call, held, schedule, enqueueRun, project } = await seed(prisma);
    await schedule();
    await enqueueRun();
    expect(await masterQueueMembers(a.project.id)).toHaveLength(1);

    const preview = await held(() => call("delete_project"));
    await approveAll();
    const result = await call("delete_project");
    const again = await call("delete_project");

    const lines = preview.split("\n");
    expect(lines[0]).toContain(`(slug ${a.project.slug}, ref`);
    expect(lines.slice(2, 6)).toEqual([
      "Environments: 5 (including 1 preview branch and 1 dev branch).",
      "Production: no current deployment.",
      "Schedules: 1 active schedule; schedules stop triggering runs.",
      "Runs: about 1 queued and 0 executing when this preview was made; these counts are not checked again.",
    ]);
    expect(result.isError).toBeUndefined();
    expect((await project()).deletedAt).toBeInstanceOf(Date);
    expect(await masterQueueMembers(a.project.id)).toEqual([]);
    expect(textOf(again)).toBe("Not authorized");
  });

  // Catches: live run counts in the approval binding, or a stable fact (schedules, environments) left out of it.
  postgresTest("binds the approval to stable facts, not run counts", async ({ prisma }) => {
    const changes = {
      run: (s: Awaited<ReturnType<typeof seed>>) => s.enqueueRun(),
      schedule: (s: Awaited<ReturnType<typeof seed>>) => s.schedule(),
      environment: (s: Awaited<ReturnType<typeof seed>>) =>
        createRuntimeEnvironment(prisma, {
          projectId: s.a.project.id,
          organizationId: s.a.organization.id,
          type: "STAGING",
          slug: "stg",
        }),
    };

    const outcomes: Record<string, { stale: boolean; deleted: boolean }> = {};
    for (const [name, change] of Object.entries(changes)) {
      const s = await seed(prisma);
      await s.held(() => s.call("delete_project"));
      await approveAll();
      await change(s);
      const result = await s.call("delete_project");
      outcomes[name] = {
        stale: textOf(result) === STALE,
        deleted: (await s.project()).deletedAt !== null,
      };
    }

    expect(outcomes).toEqual({
      run: { stale: false, deleted: true },
      schedule: { stale: true, deleted: false },
      environment: { stale: true, deleted: false },
    });
  });

  // Catches: an approval used after the project was renamed elsewhere, deleting a project the user did not see.
  postgresTest("refuses when the project is renamed after the preview", async ({ prisma }) => {
    const { a, call, held, enqueueRun, project } = await seed(prisma);
    await enqueueRun();
    await held(() => call("delete_project"));
    await approveAll();
    await prisma.project.update({ where: { id: a.project.id }, data: { name: "Theirs" } });

    const result = await call("delete_project");

    expect({
      text: textOf(result),
      project: await project().then(({ name, deletedAt }) => ({ name, deletedAt })),
      queues: (await masterQueueMembers(a.project.id)).length,
    }).toEqual({ text: STALE, project: { name: "Theirs", deletedAt: null }, queues: 1 });
  });

  // Catches: the bound environment set covering only the displayed environments, or only their count.
  postgresTest("binds environments past the display cap", async ({ prisma }) => {
    const { a, call, held, project } = await seed(prisma);
    const environment = (n: number) => ({
      slug: `bulk-${n}`,
      shortcode: uniqueId(`sc${n}`),
      apiKey: uniqueId(`api${n}`),
      pkApiKey: uniqueId(`pk${n}`),
      type: "PREVIEW" as const,
      projectId: a.project.id,
      organizationId: a.organization.id,
    });
    await prisma.runtimeEnvironment.createMany({
      data: Array.from({ length: 1000 }, (_, n) => environment(n)),
    });
    await held(() => call("delete_project"));
    await approveAll();
    await prisma.runtimeEnvironment.updateMany({
      where: { projectId: a.project.id, slug: "bulk-999" },
      data: { archivedAt: new Date() },
    });
    await prisma.runtimeEnvironment.create({ data: environment(1000) });

    const result = await call("delete_project");

    expect({ text: textOf(result), deletedAt: (await project()).deletedAt }).toEqual({
      text: STALE,
      deletedAt: null,
    });
  });

  // Catches: a Redis error while counting runs failing the tool instead of the runs line, or blocking the approved delete.
  postgresTest("says runs could not be counted when Redis fails", async ({ prisma }) => {
    const { call, held, prodEnv, project } = await seed(prisma);
    await redis.set(
      `engine:runqueue:${engine.runQueue.keys.envQueueKey(prodEnv)}`,
      "not a sorted set"
    );

    const preview = await held(() => call("delete_project"));

    await approveAll();
    const result = await call("delete_project");

    expect({
      runs: preview.split("\n")[5],
      deleted: !result.isError && (await project()).deletedAt !== null,
    }).toEqual({
      runs: "Runs: queued and executing runs could not be counted right now.",
      deleted: true,
    });
  });

  // Catches: a failed delete reported as done, or as leaving the project deleted when the service never marked it.
  postgresTest("says the project is not deleted when the delete fails", async ({ prisma }) => {
    const { prod, call, held, project } = await seed(prisma);
    await held(() => call("delete_project"));
    await approveAll();
    const shard = engine.runQueue.keys.masterQueueShardForEnvironment(prod.id, 4);
    const brokenKey = `engine:runqueue:masterQueue:shard:${shard}`;
    await redis.set(brokenKey, "not a sorted set");

    const result = await call("delete_project").finally(() => redis.del(brokenKey));

    expect({
      isError: result.isError,
      notDeleted: textOf(result).includes("so the project is not deleted"),
      deletedAt: (await project()).deletedAt,
    }).toEqual({ isError: true, notDeleted: true, deletedAt: null });
  });

  // Catches: a schedule counted when its only instance is on an archived branch, or its only live instance is inactive.
  postgresTest("does not count schedules that cannot trigger runs", async ({ prisma }) => {
    const { prod, preview, call, held, schedule } = await seed(prisma);
    const inactive = await schedule(prod.id);
    await prisma.taskScheduleInstance.updateMany({
      where: { taskScheduleId: inactive.id },
      data: { active: false },
    });
    const branch = await prisma.runtimeEnvironment.findFirstOrThrow({
      where: { parentEnvironmentId: preview.id },
    });
    await schedule(branch.id);
    await prisma.runtimeEnvironment.update({
      where: { id: branch.id },
      data: { archivedAt: new Date() },
    });

    const shown = await held(() => call("delete_project"));

    expect(shown.split("\n")[4]).toBe(
      "Schedules: 0 active schedules; schedules stop triggering runs."
    );
  });

  // Catches: the approved call reading run counts again, which the binding ignores.
  postgresTest("does not count runs again when approved", async ({ prisma }) => {
    const { call, held, project } = await seed(prisma);
    await held(() => call("delete_project"));
    await approveAll();
    await redis.config("RESETSTAT");

    const result = await call("delete_project");
    const stats = await redis.info("commandstats");

    expect({
      deleted: !result.isError && (await project()).deletedAt !== null,
      countReads: stats.split("\n").filter((line) => /^cmdstat_(zcard|scard):/.test(line)),
    }).toEqual({ deleted: true, countReads: [] });
  });

  // Catches: a section shown to a token that lacks the right to read it.
  postgresTest("names the missing permission instead of reading a section", async ({ prisma }) => {
    const { uatCall, held } = await seed(prisma);

    const preview = await held(() => uatCall("delete_project", {}, { cap: ["manage:project"] }));

    expect(preview.split("\n").slice(2, 6)).toEqual([
      "Environments: not shown, needs read:environments.",
      "Production: not shown, needs read:environments.",
      "Schedules: not shown, needs read:tasks.",
      "Runs: queued and executing runs not shown, needs read:runs.",
    ]);
    expect(preview.split("\n").at(-1)).toMatch(/environment set [0-9a-f]{12} and the facts above/);
  });

  // Catches: a token limited to one environment or another organization reaching a project-wide delete.
  postgresTest("denies callers without project-wide access", async ({ prisma }) => {
    const { a, b, prod, pat, bearer, tool, uatCall, project } = await seed(prisma);
    await prisma.orgMember.create({
      data: { organizationId: b.organization.id, userId: a.user.id },
    });
    const outsider = await pat(b.user.id);

    const outcomes = {
      missingScope: textOf(await uatCall("delete_project", {}, { cap: ["read:projects"] })),
      environmentToken: textOf(
        await uatCall("delete_project", {}, { cap: ["manage:project"], environmentId: prod.id })
      ),
      otherOrgToken: textOf(
        await uatCall(
          "delete_project",
          {},
          { cap: ["manage:project"], organizationId: b.organization.id }
        )
      ),
      nonMember: textOf(
        await tool("delete_project").handler(
          { projectRef: a.project.externalRef },
          { kind: "pat", userId: b.user.id, tokenId: outsider.id },
          bearer(outsider.secret)
        )
      ),
    };

    expect(outcomes).toEqual({
      missingScope: "Insufficient scope: this tool requires manage:project",
      environmentToken: "Not authorized",
      otherOrgToken: "Not authorized",
      nonMember: "Not authorized",
    });
    expect(pending()).toEqual([]);
    expect((await project()).deletedAt).toBeNull();
  });
});
