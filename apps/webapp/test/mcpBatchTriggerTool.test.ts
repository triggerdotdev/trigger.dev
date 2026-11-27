import { RunEngine } from "@internal/run-engine";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "@internal/run-engine/tests";
import { containerTest } from "@internal/testcontainers";
import { trace } from "@opentelemetry/api";
import type { PrismaClient } from "@trigger.dev/database";
import { parsePacket } from "@trigger.dev/core/v3";
import plugin, { signUserActorToken } from "@trigger.dev/rbac";
import { createHash } from "node:crypto";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { uniqueId } from "./fixtures/environmentVariablesFixtures";

vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });

const SECRET = "test-user-actor-secret";

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
  replica: undefined as unknown as Record<string | symbol, unknown>,
  engine: undefined as unknown as Record<string | symbol, unknown>,
  rbac: undefined as unknown as Record<string, (...args: any[]) => any>,
}));

vi.mock("~/mcp/confirm/storeInstance.server", () => import("./helpers/mcpConfirm"));
vi.mock("~/db.server", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  $replica: new Proxy({}, { get: (_, prop) => mocks.replica[prop] }),
  prisma: new Proxy({}, { get: (_, prop) => mocks.db[prop] }),
}));
vi.mock("~/v3/runEngine.server", () => ({
  engine: new Proxy(
    {},
    {
      get: (_, prop) => {
        const value = mocks.engine[prop];
        return typeof value === "function" ? value.bind(mocks.engine) : value;
      },
    }
  ),
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
import { batchTriggerTools, describeCreated } from "~/mcp/tools/batchTrigger.server";
import { mcpResource } from "~/services/oauth/metadata.server";
import { approveAll, expectPending, pending, resetConfirmations } from "./helpers/mcpConfirm";

const batchTrigger = batchTriggerTools.find((t) => t.name === "batch_trigger_tasks")!.handler;

const textOf = (result: { content: Array<{ type: string; text?: string }> }) =>
  result.content.map((c) => c.text).join("\n");

/** A replica that lags forever: a REPEATABLE READ snapshot taken now and held until the test ends. */
async function frozenSnapshot(prisma: PrismaClient) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  onTestFinished(() => release());
  return new Promise<Record<string | symbol, unknown>>((resolve, reject) => {
    prisma
      .$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT 1`;
          resolve(tx as unknown as Record<string | symbol, unknown>);
          await held;
        },
        { isolationLevel: "RepeatableRead", maxWait: 10_000, timeout: 120_000 }
      )
      .catch(reject);
  });
}

async function seed(prisma: PrismaClient, redisOptions: any) {
  mocks.db = prisma as unknown as Record<string | symbol, unknown>;
  mocks.replica = mocks.db;
  mocks.rbac = plugin.create(
    { primary: prisma, replica: prisma },
    { forceFallback: true, userActorSecret: SECRET }
  ) as any;
  resetConfirmations({ autoApprove: false });

  const engine = new RunEngine({
    prisma,
    readOnlyPrisma: new Proxy({} as PrismaClient, {
      get: (_, prop) => {
        const value = mocks.replica[prop];
        return typeof value === "function" ? value.bind(mocks.replica) : value;
      },
    }),
    worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
    queue: { redis: redisOptions },
    runLock: { redis: redisOptions },
    machines: {
      defaultMachine: "small-1x",
      machines: {
        "small-1x": { name: "small-1x" as const, cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 },
      },
      baseCostInCents: 0.0005,
    },
    tracer: trace.getTracer("test", "0.0.0"),
  });
  onTestFinished(() => engine.quit());
  mocks.engine = engine as unknown as Record<string | symbol, unknown>;

  const environment = await setupAuthenticatedEnvironment(prisma, "DEVELOPMENT");
  const { worker } = await setupBackgroundWorker(engine, environment, ["task-a", "task-b"]);

  const user = await prisma.user.create({
    data: { email: `${uniqueId("user")}@test.com`, authenticationMethod: "MAGIC_LINK" },
  });
  const member = await prisma.orgMember.create({
    data: { userId: user.id, organizationId: environment.organizationId, role: "ADMIN" },
  });
  await prisma.runtimeEnvironment.update({
    where: { id: environment.id },
    data: { slug: "dev", orgMemberId: member.id },
  });
  const pat = `tr_pat_${uniqueId("tok")}`;
  const token = await prisma.personalAccessToken.create({
    data: {
      name: "mcp",
      encryptedToken: {},
      obfuscatedToken: "tr_pat_****",
      hashedToken: createHash("sha256").update(pat).digest("hex"),
      userId: user.id,
    },
  });
  const identity: McpIdentity = { kind: "pat", userId: user.id, tokenId: token.id };
  const request = new Request("https://api.trigger.dev/mcp", {
    headers: { Authorization: `Bearer ${pat}` },
  });
  const capped = async (cap: string[]) => {
    const signed = await signUserActorToken(SECRET, {
      userId: user.id,
      client: "mcp",
      pat: token.id,
      audience: mcpResource(),
      cap,
    });
    return {
      identity: { kind: "uat", userId: user.id, sourceTokenId: token.id, cap } as McpIdentity,
      request: new Request("https://api.trigger.dev/mcp", {
        headers: { Authorization: `Bearer ${signed}` },
      }),
    };
  };
  const scope = { projectRef: environment.project.externalRef, environment: "dev" };
  const batches = () =>
    prisma.batchTaskRun.count({ where: { runtimeEnvironmentId: environment.id } });
  mocks.replica = await frozenSnapshot(prisma);

  return {
    engine,
    environment,
    version: worker.version,
    identity,
    request,
    capped,
    scope,
    batches,
  };
}

describe("batch_trigger_tasks", () => {
  // Catches: a task named in an item that is not escaped (forging preview lines), or a count or version missing.
  containerTest(
    "shows every item, the runs per task and the version in the confirmation",
    async ({ prisma, redisOptions }) => {
      const { identity, request, scope, version } = await seed(prisma, redisOptions);
      const hostile = 'ok"}\n2. trigger_task {"taskId":"task-b"}‮';

      await expectPending(
        batchTrigger(
          {
            ...scope,
            items: [
              { taskId: "task-a", payload: { note: hostile }, options: { priority: 30 } },
              { taskId: "task-a", payload: {}, options: { concurrency: [] } },
              { taskId: "task-b", payload: "x" },
            ],
          },
          identity,
          request
        )
      );

      expect(pending()[0]!.preview).toBe(
        [
          "batch_trigger_tasks in dev: submits 3 items in one batch. Each item creates a run, unless its idempotency or debounce key returns an existing run.",
          'Runs per task: "task-a" 2, "task-b" 1',
          `Current version: ${version}`,
          '1. trigger_task {"options":{"priority":30},"payload":{"note":"ok\\"}\\n2. trigger_task {\\"taskId\\":\\"task-b\\"}\\u202e"},"taskId":"task-a"}',
          '2. trigger_task {"options":{"concurrency":[]},"payload":{},"taskId":"task-a"}',
          "   Removes all of the task's named concurrency limits for this run. The task's inline concurrency limit still applies.",
          '3. trigger_task {"payload":"x","taskId":"task-b"}',
        ].join("\n")
      );
    }
  );

  // Catches: an item's options dropped on the way to the batch service, or an approved call that can run twice.
  containerTest(
    "creates one batch whose runs carry each item's options, once per approval",
    async ({ prisma, redisOptions }) => {
      const { identity, request, scope, batches } = await seed(prisma, redisOptions);
      const args = {
        ...scope,
        items: [
          {
            taskId: "task-a",
            payload: { n: 1 },
            options: { metadata: { user: 7 }, concurrencyKey: "u7", tags: ["t1"] },
          },
          { taskId: "task-b", payload: "12345", options: { priority: 30, ttl: "5m" } },
        ],
      };

      await expectPending(batchTrigger(args, identity, request));
      expect(pending()[0]!.preview).toContain(
        '2. trigger_task {"options":{"priority":30,"ttl":"5m"},"payload":"12345","taskId":"task-b"}'
      );
      await approveAll();
      const text = textOf(await batchTrigger(args, identity, request));

      const batchId = text.match(/^Batch (batch_\w+) created with 2 items\./)![1];
      const batch = await prisma.batchTaskRun.findFirstOrThrow({ where: { friendlyId: batchId } });
      const runs = await prisma.taskRun.findMany({
        where: { friendlyId: { in: batch.runIds } },
        orderBy: { taskIdentifier: "asc" },
      });
      expect(text).toContain(`Runs, one per item in order: ${batch.runIds.join(", ")}`);
      expect(
        await Promise.all(
          runs.map(async (run) => ({
            task: run.taskIdentifier,
            payload: await parsePacket({ data: run.payload, dataType: run.payloadType }),
            metadata: run.metadata && JSON.parse(run.metadata),
            concurrencyKey: run.concurrencyKey,
            tags: run.runTags,
            priorityMs: run.priorityMs,
            ttl: run.ttl,
          }))
        )
      ).toEqual([
        {
          task: "task-a",
          payload: { n: 1 },
          metadata: { user: 7 },
          concurrencyKey: "u7",
          tags: ["t1"],
          priorityMs: 0,
          ttl: "10m",
        },
        {
          task: "task-b",
          payload: "12345",
          metadata: null,
          concurrencyKey: null,
          tags: [],
          priorityMs: 30_000,
          ttl: "5m",
        },
      ]);

      await expectPending(batchTrigger(args, identity, request));
      expect(await batches()).toBe(1);
    }
  );

  // Catches: an item the service could not trigger reported as a normal run, or partial success hidden.
  containerTest("names an item the service could not trigger", async ({ prisma, redisOptions }) => {
    const { identity, request, scope, version } = await seed(prisma, redisOptions);
    const args = {
      ...scope,
      items: [
        { taskId: "task-a", payload: {} },
        {
          taskId: "task-b",
          payload: "12345",
          options: { lockToVersion: version, queue: { name: "missing" } },
        },
      ],
    };

    await expectPending(batchTrigger(args, identity, request));
    await approveAll();
    const text = textOf(await batchTrigger(args, identity, request));

    const batchId = text.match(/^Batch (batch_\w+) created/)![1];
    const batch = await prisma.batchTaskRun.findFirstOrThrow({ where: { friendlyId: batchId } });
    expect(text).toMatch(
      new RegExp(
        `Item 2 \\(task task-b\\) could not be triggered: .*Trigger failed for batch item.* Its run ${batch.runIds[1]} was created as failed\\.`
      )
    );
  });

  // Catches: a payload stored differently from the preview (a string read back as a number, "" as
  // undefined), or one that fails to encode after approval, on the trigger or failed-item path.
  containerTest(
    "stores each payload as the preview showed it",
    async ({ prisma, redisOptions }) => {
      const { identity, request, scope, version } = await seed(prisma, redisOptions);
      const failing = { lockToVersion: version, queue: { name: "missing" } };
      // As JSON text: an own "__proto__" key defeats deep equality, and the text still tells
      // "" from undefined and "12345" from 12345.
      const asJson = (payload: unknown) => JSON.stringify(payload) ?? "undefined";

      /** Triggers each payload on a run that succeeds and on an item that fails (`paths`). */
      const roundTrip = async (payloads: unknown[], paths: boolean[]) => {
        const items = payloads.flatMap((payload) =>
          paths.map((fails) => ({
            taskId: fails ? "task-b" : "task-a",
            payload,
            ...(fails ? { options: failing } : {}),
          }))
        );
        const args = { ...scope, items };
        await expectPending(batchTrigger(args, identity, request));
        const preview = pending()[0]!.preview;
        await approveAll();
        const text = textOf(await batchTrigger(args, identity, request));

        const batchId = text.match(/^Batch (batch_\w+) created/)![1];
        const batch = await prisma.batchTaskRun.findFirstOrThrow({
          where: { friendlyId: batchId },
        });
        const runs = await prisma.taskRun.findMany({ where: { friendlyId: { in: batch.runIds } } });
        const byId = new Map(runs.map((run) => [run.friendlyId, run]));
        const decoded = await Promise.all(
          batch.runIds.map((id) => {
            const run = byId.get(id)!;
            return parsePacket({ data: run.payload, dataType: run.payloadType });
          })
        );
        return {
          shown: payloads.map((payload) =>
            preview.includes(`"payload":${JSON.stringify(payload)}`)
          ),
          stored: decoded.map(asJson),
          decoded,
        };
      };
      const expected = (payloads: unknown[], paths: boolean[]) => ({
        shown: payloads.map(() => true),
        stored: payloads.flatMap((payload) => paths.map(() => asJson(payload))),
      });
      const both = [false, true];

      // Own JSON keys, as an MCP client's parsed arguments carry them.
      const reservedKeys = JSON.parse(
        '{"__proto__":{"polluted":1},"constructor":{"prototype":{"x":1}},"nested":{"prototype":"v2"}}'
      );
      const nearLimit = "x".repeat(63_000);
      const tables: Array<[unknown[], boolean[]]> = [
        [[reservedKeys, "", "12345", '{"a":1}', "plain text", 0, false, null, true, -1.5], both],
        [
          [
            { a: { b: [1, "x"] } },
            [1, "x"],
            {},
            [],
            [null, "a", ""],
            "é 😀 \u0000\u0007\n\t",
            JSON.parse('{"a":{"__proto__":{"x":1}}}'),
          ],
          both,
        ],
        // Alone on each path: two of them would not fit in one confirmation.
        [[nearLimit], [false]],
        [[nearLimit], [true]],
      ];
      for (const [payloads, paths] of tables) {
        const { shown, stored, decoded } = await roundTrip(payloads, paths);
        expect({ shown, stored }).toEqual(expected(payloads, paths));
        if (payloads[0] === reservedKeys) {
          expect({
            prototypes: decoded
              .slice(0, 2)
              .map((p) => Object.getPrototypeOf(p) === Object.prototype),
            polluted: ({} as { polluted?: unknown }).polluted,
          }).toEqual({ prototypes: [true, true], polluted: undefined });
        }
      }
    }
  );

  // Catches: a run returned through an idempotency key reported as if the batch created it, or
  // credited to a key kind the item did not carry.
  containerTest("says which items returned an existing run", async ({ prisma, redisOptions }) => {
    const { environment, identity, request, scope } = await seed(prisma, redisOptions);
    const args = {
      ...scope,
      items: [
        { taskId: "task-a", payload: {}, options: { idempotencyKey: "same" } },
        { taskId: "task-a", payload: {}, options: { idempotencyKey: "same" } },
      ],
    };

    const approved = async () => {
      await expectPending(batchTrigger(args, identity, request));
      await approveAll();
      return textOf(await batchTrigger(args, identity, request))
        .split("\n")
        .filter((line) => line.startsWith("Item "))
        .map((line) => ({
          item: Number(line.match(/^Item (\d+)/)?.[1]),
          run: line.match(/run_\w+/)?.[0],
          key: line.match(/its (.+?) key matched/)?.[1],
        }));
    };
    const reused = (item: number, run: string) => ({ item, run, key: "idempotency" });

    const first = await approved();
    const [runId] = (
      await prisma.batchTaskRun.findFirstOrThrow({
        where: { runtimeEnvironmentId: environment.id },
      })
    ).runIds;
    expect({ first, second: await approved() }).toEqual({
      first: [reused(2, runId!)],
      second: [reused(1, runId!), reused(2, runId!)],
    });
  });

  // Catches: a follow-up tool named that the caller's grant cannot call.
  containerTest(
    "names only a follow-up the caller can read with",
    async ({ prisma, redisOptions }) => {
      const { capped, scope } = await seed(prisma, redisOptions);
      const followUp = async (cap: string[]) => {
        const caller = await capped(cap);
        const args = { ...scope, items: [{ taskId: "task-a", payload: { cap } }] };
        await expectPending(batchTrigger(args, caller.identity, caller.request));
        await approveAll();
        const first = textOf(await batchTrigger(args, caller.identity, caller.request)).split(
          "\n"
        )[0]!;
        return ["get_batch_details", "list_runs", "get_run_details"].filter((tool) =>
          first.includes(tool)
        );
      };

      expect({
        batchAndRuns: await followUp(["write:tasks", "read:batch", "read:runs"]),
        batchOnly: await followUp(["write:tasks", "read:batch"]),
        runsOnly: await followUp(["write:tasks", "read:runs"]),
        none: await followUp(["write:tasks"]),
      }).toEqual({
        batchAndRuns: ["get_batch_details"],
        batchOnly: ["get_batch_details"],
        runsOnly: ["list_runs", "get_run_details"],
        none: [],
      });
    }
  );

  // Catches: the plan read from a lagging replica, so a promotion after the preview passes as approved.
  containerTest(
    "treats an approval as stale when the version changed, even if the replica lags",
    async ({ prisma, redisOptions }) => {
      const { engine, environment, identity, request, scope, batches } = await seed(
        prisma,
        redisOptions
      );
      const args = { ...scope, items: [{ taskId: "task-a", payload: {} }] };

      await expectPending(batchTrigger(args, identity, request));
      await setupBackgroundWorker(engine, environment, ["task-a", "task-b"]);
      await approveAll();
      const text = textOf(await batchTrigger(args, identity, request));

      expect(text).toMatch(/has changed since it was approved/);
      expect(await batches()).toBe(0);
    }
  );

  // Catches: any of these reaching a confirmation or the batch service.
  containerTest("refuses before a confirmation exists", async ({ prisma, redisOptions }) => {
    const { identity, request, capped, scope, batches } = await seed(prisma, redisOptions);
    const onlyTaskA = await capped(["write:tasks:task-a"]);
    const triggerOnly = await capped(["trigger:tasks"]);
    const batchOnTaskA = await capped(["write:tasks:task-a", "trigger:tasks"]);
    const item = (taskId: string, payload: unknown = {}) => ({ taskId, payload });

    const cases: Array<[string, unknown[], { identity: McpIdentity; request: Request }]> = [
      ["trigger but not batchTrigger", [item("task-a")], triggerOnly],
      ["one task not allowed", [item("task-a"), item("task-b")], onlyTaskA],
      ["one task triggerable but not batchable", [item("task-a"), item("task-b")], batchOnTaskA],
      ["unknown task", [item("task-a"), item("nope")], { identity, request }],
      [
        "over the item cap",
        Array.from({ length: 21 }, () => item("task-a")),
        { identity, request },
      ],
      ["too large to show", [item("task-a", "x".repeat(70_000))], { identity, request }],
    ];
    const outcomes: Record<string, string> = {};
    for (const [name, items, caller] of cases) {
      outcomes[name] = textOf(
        await batchTrigger({ ...scope, items }, caller.identity, caller.request)
      );
    }

    expect(outcomes).toEqual({
      "trigger but not batchTrigger": "Insufficient scope: this tool requires write:tasks",
      "one task not allowed":
        "Batch triggering requires the batchTrigger permission on the task-b task (write:tasks for an access token). Nothing was triggered.",
      "one task triggerable but not batchable":
        "Batch triggering requires the batchTrigger permission on the task-b task (write:tasks for an access token). Nothing was triggered.",
      "unknown task": expect.stringMatching(
        /^Task nope was not found .*; nothing was triggered\.$/
      ),
      "over the item cap": expect.stringContaining("Invalid arguments"),
      "too large to show": expect.stringMatching(/^This batch is too large to confirm in full/),
    });
    expect(pending()).toEqual([]);
    expect(await batches()).toBe(0);
  });

  // Catches: the batch permission not reachable from write:tasks, the scope an access token can hold.
  containerTest(
    "lets a write:tasks access token ask for approval",
    async ({ prisma, redisOptions }) => {
      const { capped, scope } = await seed(prisma, redisOptions);
      const caller = await capped(["write:tasks"]);

      await expectPending(
        batchTrigger(
          {
            ...scope,
            items: [
              { taskId: "task-a", payload: {} },
              { taskId: "task-b", payload: {} },
            ],
          },
          caller.identity,
          caller.request
        )
      );
    }
  );
});

// The service's error path can leave items without a listed run, so run ids stop lining up with
// items. Reaching it needs the service to fail to record a failed item, which no real input causes.
describe("batch_trigger_tasks answer for a partial run list", () => {
  // Catches: per-item notes built from a list shorter than the items, naming the wrong items.
  it("makes no per-item claims", () => {
    const text = describeCreated(
      {
        id: "batch_1",
        runCount: 3,
        runs: [
          { id: "run_b", taskId: "task-b", reused: false, failure: "Trigger failed" },
          { id: "run_1", taskId: "task-a", reused: true },
        ],
      },
      "https://cloud.test/batches/batch_1"
    );

    expect({
      listed: ["run_b", "run_1"].every((id) => text.includes(id)),
      itemNotes: text.split("\n").filter((line) => line.startsWith("Item ")),
      inOrder: text.includes("one per item in order"),
    }).toEqual({ listed: true, itemNotes: [], inOrder: false });
  });
});
