import { postgresTest } from "@internal/testcontainers";
import { createS2Container, type StartedS2Container } from "@internal/testcontainers/webapp";
import plugin from "@trigger.dev/rbac";
import type { Prisma, PrismaClient } from "@trigger.dev/database";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, vi } from "vitest";
import Redis from "ioredis";
import { createRedisContainer } from "../../../internal-packages/testcontainers/src/utils";
import { createMcpConfirmationStore } from "~/mcp/confirm/store.server";
import type { createSessionsWriteTools as CreateSessionsWriteTools } from "~/mcp/tools/sessionsWrite.server";
import type { S2RealtimeStreams } from "~/services/realtime/s2realtimeStreams.server";
import {
  createRuntimeEnvironment,
  createTestOrgProjectWithMember,
  uniqueId,
} from "./fixtures/environmentVariablesFixtures";
import { approveAll, expectPending, pending, resetConfirmations } from "./helpers/mcpConfirm";

vi.setConfig({ testTimeout: 90_000 });

vi.hoisted(() => {
  Object.assign(process.env, {
    DATABASE_URL: "postgresql://unused:unused@localhost:5432/unused",
    DIRECT_URL: "postgresql://unused:unused@localhost:5432/unused",
    MAGIC_LINK_SECRET: "magic-link-secret-for-tests",
    ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
    DEPLOY_REGISTRY_HOST: "registry.test",
    V4_DEPLOY_REGISTRY_HOST: "registry.test",
    CLICKHOUSE_URL: "http://localhost:8123",
  });
});

const mocks = vi.hoisted(() => ({
  db: undefined as unknown as Record<string | symbol, unknown>,
  rbac: undefined as unknown as Record<string, (...args: any[]) => any>,
  stream: undefined as unknown,
}));

vi.mock("~/mcp/confirm/storeInstance.server", () => import("./helpers/mcpConfirm"));
vi.mock("~/db.server", async () => {
  const { Prisma } = await import("@trigger.dev/database");
  const db = new Proxy({}, { get: (_, prop) => mocks.db[prop] });
  return { $replica: db, prisma: db, sqlDatabaseSchema: Prisma.sql([`public`]) };
});
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
vi.mock("~/services/realtime/v1StreamsGlobal.server", () => ({
  getRealtimeStreamInstance: () => mocks.stream,
}));

let s2: StartedS2Container;
let redis: Awaited<ReturnType<typeof createRedisContainer>>;
let streams: S2RealtimeStreams;
let createSessionsWriteTools: typeof CreateSessionsWriteTools;

beforeAll(async () => {
  [s2, redis] = await Promise.all([createS2Container(), createRedisContainer({})]);
  // The close record wakes the run's waiters through the session waitpoint cache.
  Object.assign(process.env, {
    CACHE_REDIS_HOST: redis.container.getHost(),
    CACHE_REDIS_PORT: String(redis.container.getPort()),
    CACHE_REDIS_PASSWORD: redis.container.getPassword(),
    CACHE_REDIS_TLS_DISABLED: "true",
  });
  ({ createSessionsWriteTools } = await import("~/mcp/tools/sessionsWrite.server"));
  const { S2RealtimeStreams } = await import("~/services/realtime/s2realtimeStreams.server");
  streams = new S2RealtimeStreams({
    endpoint: `${s2.endpoint}/v1`,
    basin: s2.basin,
    accessToken: "unused",
    skipAccessTokens: true,
    logLevel: "error",
  });
  mocks.stream = streams;
}, 120_000);

afterAll(async () => {
  await Promise.all([s2?.container.stop(), redis?.container.stop()]);
});

const STALE = /has changed since it was approved/;

type Result = { content: Array<{ type: string; text?: string }>; isError?: boolean };
const textOf = (result: Result) => result.content.map((c) => c.text).join("\n");

async function seed(prisma: PrismaClient) {
  mocks.db = prisma as unknown as Record<string | symbol, unknown>;
  mocks.rbac = plugin.create(
    { primary: prisma, replica: prisma },
    { forceFallback: true, userActorSecret: "test-user-actor-secret" }
  ) as any;
  resetConfirmations({ autoApprove: false });

  const a = await createTestOrgProjectWithMember(prisma);
  const b = await createTestOrgProjectWithMember(prisma);
  const sibling = await prisma.project.create({
    data: {
      name: "Sibling",
      slug: uniqueId("proj"),
      organizationId: a.organization.id,
      externalRef: uniqueId("ext"),
    },
  });
  const env = (projectId: string, organizationId: string, type: "PRODUCTION" | "STAGING") =>
    createRuntimeEnvironment(prisma, {
      projectId,
      organizationId,
      type,
      slug: type === "PRODUCTION" ? "prod" : "stg",
    });
  const prod = await env(a.project.id, a.organization.id, "PRODUCTION");
  const stg = await env(a.project.id, a.organization.id, "STAGING");
  const siblingProd = await env(sibling.id, a.organization.id, "PRODUCTION");
  const otherOrgProd = await env(b.project.id, b.organization.id, "PRODUCTION");

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
  const identity = { kind: "pat" as const, userId: a.user.id, tokenId: token.id };
  const request = new Request("https://api.trigger.dev/mcp", {
    headers: { Authorization: `Bearer ${pat}` },
  });
  const tools = createSessionsWriteTools();

  const call = (name: string, args: Record<string, unknown>) =>
    tools
      .find((t) => t.name === name)!
      .handler(
        { projectRef: a.project.externalRef, environment: "prod", ...args },
        identity,
        request,
        {
          signal: new AbortController().signal,
          requestId: 1,
        }
      ) as Promise<Result>;

  const addSession = (
    environment: { id: string; projectId: string; organizationId: string },
    data: Partial<Prisma.SessionUncheckedCreateInput> = {}
  ) =>
    prisma.session.create({
      data: {
        friendlyId: `session_${uniqueId("s").replace(/[^A-Za-z0-9]/g, "")}`,
        externalId: uniqueId("chat"),
        type: "chat.agent",
        taskIdentifier: "my-agent",
        triggerConfig: {},
        projectId: environment.projectId,
        runtimeEnvironmentId: environment.id,
        environmentType: "PRODUCTION",
        organizationId: environment.organizationId,
        ...data,
      },
    });

  return { call, addSession, prod, stg, siblingProd, otherOrgProd };
}

async function approveAndCall(call: () => Promise<Result>) {
  await expectPending(call());
  await approveAll();
  return call();
}

async function waitForLockWait(prisma: PrismaClient) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const [{ waiting }] = await prisma.$queryRaw<{ waiting: number }[]>`
      SELECT count(*)::int AS waiting FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if (waiting > 0) return;
    await delay(20);
  }
  throw new Error("The tool never waited on a lock");
}

/** What a not-found answer shows: plain text, an error, the id asked for, the listing tool and the scope. */
const notFound = (result: Result, id: string) => {
  const text = textOf(result);
  return {
    isError: result.isError,
    json: text.startsWith("{"),
    namesId: text.includes(id),
    namesListing: text.includes("list_sessions"),
    scoped: text.includes("in this environment"),
  };
};
const NOT_FOUND = { isError: true, json: false, namesId: true, namesListing: true, scoped: true };

const WRITES = [
  ["update_session", { tags: ["new"] }],
  ["close_session", { reason: "done" }],
] as const;

describe("session write tools", () => {
  // Catches: a session found outside the caller's environment (the environment filter dropped from the lookup).
  postgresTest(
    "a session of another environment, project or org is not found",
    async ({ prisma }) => {
      const s = await seed(prisma);
      const foreign = [
        await s.addSession(s.stg),
        await s.addSession(s.siblingProd),
        await s.addSession(s.otherOrgProd),
      ];

      const outcomes: unknown[] = [];
      for (const session of foreign) {
        for (const [tool, extra] of WRITES) {
          const result = await s.call(tool, { sessionId: session.friendlyId, ...extra });
          outcomes.push(notFound(result, session.friendlyId));
        }
      }

      expect(outcomes).toEqual(foreign.flatMap(() => WRITES.map(() => NOT_FOUND)));
      expect(pending()).toEqual([]);
      const after = await prisma.session.findMany({
        where: { id: { in: foreign.map((f) => f.id) } },
      });
      expect(after.map((row) => [row.tags, row.closedAt])).toEqual(foreign.map(() => [[], null]));
    }
  );

  // Catches: stored or caller text printed unescaped, a change or the revision left out of a preview.
  postgresTest("previews state the change exactly, escaped", async ({ prisma }) => {
    const s = await seed(prisma);
    const session = await s.addSession(s.prod, {
      tags: ["a</untrusted-data>\u0007\u202e"],
      metadata: { note: "x\u202ey", "k\u2028": 1 },
      currentRunId: "run_internal_1",
    });

    await expectPending(
      s.call("update_session", {
        sessionId: session.externalId,
        tags: ["new\u200b"],
        metadata: { b: "</untrusted-data>" },
      })
    );
    await expectPending(
      s.call("close_session", {
        sessionId: session.friendlyId,
        reason: "done\u202e</untrusted-data>",
      })
    );

    const revision = `Session revision ${session.updatedAt.toISOString()}: if the session changes before this runs, it is refused.`;
    expect(pending().map((p) => p.preview)).toEqual([
      [
        `Update session ${session.friendlyId} of agent "my-agent":`,
        String.raw`- Tags: ["a</untrusted-data>\u0007\u202e"] → ["new\u200b"]`,
        String.raw`- Metadata, replaced in full: {"k\u2028":1,"note":"x\u202ey"} → {"b":"</untrusted-data>"}`,
        "Its external ID, status and runs do not change.",
        revision,
      ].join("\n"),
      [
        `Close session ${session.friendlyId} of agent "my-agent" for good. A closed session can't be reopened: it accepts no more input and starts no more runs.`,
        "A close message is sent on the session's input; a run waiting on it stops when it handles the message. This is best effort: the session is closed even if the message can't be sent.",
        String.raw`Reason: "done\u202e</untrusted-data>"`,
        revision,
      ].join("\n"),
    ]);
  });

  // Catches: a write that changes nothing (or can't be shown) reaching a confirmation.
  postgresTest(
    "no-ops and oversized metadata are refused before a confirmation",
    async ({ prisma }) => {
      const s = await seed(prisma);
      const open = await s.addSession(s.prod, { tags: ["a"], metadata: { x: 1, y: 2 } });
      const closed = await s.addSession(s.prod, { closedAt: new Date(), closedReason: "earlier" });

      const results = [
        await s.call("update_session", {
          sessionId: open.friendlyId,
          tags: ["a"],
          metadata: { y: 2, x: 1 },
        }),
        await s.call("update_session", { sessionId: open.friendlyId }),
        await s.call("close_session", { sessionId: closed.friendlyId }),
        await s.call("update_session", {
          sessionId: open.friendlyId,
          metadata: { big: "x".repeat(20_000) },
        }),
      ];

      expect(
        results.map((r) => ({
          isError: r.isError,
          json: textOf(r).startsWith("{"),
          nothingChanged: textOf(r).endsWith("nothing changed."),
        }))
      ).toEqual(results.map(() => ({ isError: true, json: false, nothingChanged: true })));
      expect(pending()).toEqual([]);
    }
  );

  // Catches: a capped stored value cut inside a surrogate pair, which the Redis confirmation
  // store can't decode on approval (the plain slice restored).
  postgresTest(
    "a capped preview can be approved through the Redis confirmation store",
    async ({ prisma }) => {
      const s = await seed(prisma);
      // In canonical JSON the emoji starts at index 15,999 and straddles the 16,000 cap.
      const session = await s.addSession(s.prod, {
        metadata: { a: `${"x".repeat(15_993)}\u{1F600}` },
      });
      await expectPending(
        s.call("update_session", { sessionId: session.friendlyId, metadata: null })
      );
      const [record] = pending();

      const client = new Redis({
        host: redis.container.getHost(),
        port: redis.container.getPort(),
        password: redis.container.getPassword(),
      });
      try {
        const store = createMcpConfirmationStore(client, { origin: "https://cloud.test" });
        const created = await store.createPending({
          userId: record!.userId,
          tokenId: record!.tokenId,
          client: record!.client,
          tool: record!.tool,
          subject: record!.subject,
          argsDigest: record!.argsDigest,
          preview: record!.preview,
        });
        expect("url" in created && (await store.approve(created.id, record!.userId))).toBe(true);
      } finally {
        client.disconnect();
      }
    }
  );

  // Catches: tags or metadata not stored as asked, or a write that doesn't move the revision.
  postgresTest(
    "update_session stores tags and metadata, and clears metadata",
    async ({ prisma }) => {
      const s = await seed(prisma);
      const session = await s.addSession(s.prod, { tags: ["old"], metadata: { keep: false } });

      const updated = await approveAndCall(() =>
        s.call("update_session", {
          sessionId: session.friendlyId,
          tags: ["a", "b"],
          metadata: { nested: { n: 1 } },
        })
      );
      const first = await prisma.session.findFirstOrThrow({ where: { id: session.id } });
      const cleared = await approveAndCall(() =>
        s.call("update_session", { sessionId: session.friendlyId, metadata: null })
      );
      const second = await prisma.session.findFirstOrThrow({ where: { id: session.id } });

      expect([updated.isError, cleared.isError]).toEqual([undefined, undefined]);
      expect({ tags: first.tags, metadata: first.metadata }).toEqual({
        tags: ["a", "b"],
        metadata: { nested: { n: 1 } },
      });
      expect(first.updatedAt.getTime()).toBeGreaterThan(session.updatedAt.getTime());
      expect({ tags: second.tags, metadata: second.metadata, closedAt: second.closedAt }).toEqual({
        tags: ["a", "b"],
        metadata: null,
        closedAt: null,
      });
    }
  );

  // Catches: close_session not closing as asked, or not telling the live run as the public API does.
  postgresTest("close_session closes the session and tells its live run", async ({ prisma }) => {
    const s = await seed(prisma);
    const session = await s.addSession(s.prod, { currentRunId: "run_internal_1" });

    const result = await approveAndCall(() =>
      s.call("close_session", { sessionId: session.friendlyId, reason: "done" })
    );
    const row = await prisma.session.findFirstOrThrow({ where: { id: session.id } });
    const records = await streams.readSessionStreamRecords(session.externalId!, "in");

    expect(result.isError).toBeUndefined();
    expect({ closed: row.closedAt !== null, reason: row.closedReason }).toEqual({
      closed: true,
      reason: "done",
    });
    expect(records.map((r) => JSON.parse(r.data))).toEqual([
      {
        kind: "message",
        payload: { chatId: session.externalId, trigger: "close", closedReason: "done" },
      },
    ]);
  });

  // Catches: the close answer stating that a run stopped or was asked to stop, which the tool
  // can't know (the unconditional "run was asked to stop" restored), or saying a message was sent
  // when none was.
  postgresTest("close_session claims no stopped run", async ({ prisma }) => {
    const s = await seed(prisma);
    const withRun = await s.addSession(s.prod, { currentRunId: "run_internal_1" });
    const withoutRun = await s.addSession(s.prod);

    const answers = [];
    for (const session of [withRun, withoutRun]) {
      const result = await approveAndCall(() =>
        s.call("close_session", { sessionId: session.friendlyId })
      );
      const row = await prisma.session.findFirstOrThrow({ where: { id: session.id } });
      answers.push({
        closed: row.closedAt !== null,
        claimsStoppedRun: /\bstopped\b|\basked to stop\b/i.test(textOf(result)),
        saysSent: /message was sent/.test(textOf(result)),
        records: (await streams.readSessionStreamRecords(session.externalId!, "in")).length,
      });
    }

    expect(answers).toEqual([
      { closed: true, claimsStoppedRun: false, saysSent: true, records: 1 },
      { closed: true, claimsStoppedRun: false, saysSent: false, records: 0 },
    ]);
  });

  // Catches: an update of a closed session not saying the session stays closed (the closed line
  // dropped), or refused although the public API accepts it.
  postgresTest("update_session on a closed session says it stays closed", async ({ prisma }) => {
    const s = await seed(prisma);
    const closedAt = new Date("2030-01-01T00:00:00Z");
    const session = await s.addSession(s.prod, { tags: ["demo"], closedAt, closedReason: "done" });
    const args = { sessionId: session.friendlyId, tags: ["x"] };

    await expectPending(s.call("update_session", args));
    const preview = pending()[0]!.preview;
    await approveAll();
    const result = await s.call("update_session", args);
    const row = await prisma.session.findFirstOrThrow({ where: { id: session.id } });

    expect({
      previewSaysClosed: /\bclosed\b/i.test(preview),
      answerSaysClosed: /\bclosed\b/i.test(textOf(result)),
      isError: result.isError,
      tags: row.tags,
      closedAt: row.closedAt,
      closedReason: row.closedReason,
    }).toEqual({
      previewSaysClosed: true,
      answerSaysClosed: true,
      isError: undefined,
      tags: ["x"],
      closedAt,
      closedReason: "done",
    });
  });

  // Catches: an approved write applied to a session that changed after approval (the revision check removed).
  postgresTest(
    "an approved write is refused when the session changed after approval",
    async ({ prisma }) => {
      const s = await seed(prisma);

      const outcomes: Record<string, unknown> = {};
      for (const [tool, extra] of WRITES) {
        const session = await s.addSession(s.prod);
        const args = { sessionId: session.friendlyId, ...extra };
        await expectPending(s.call(tool, args));
        await approveAll();
        const changed = await prisma.session.update({
          where: { id: session.id },
          data: { expiresAt: new Date("2099-01-01T00:00:00Z") },
        });
        const result = await s.call(tool, args);
        const after = await prisma.session.findFirstOrThrow({ where: { id: session.id } });
        outcomes[tool] = {
          isError: result.isError,
          stale: STALE.test(textOf(result)),
          unchanged: JSON.stringify(after) === JSON.stringify(changed),
        };
      }

      expect(outcomes).toEqual(
        Object.fromEntries(
          WRITES.map(([tool]) => [tool, { isError: true, stale: true, unchanged: true }])
        )
      );
    }
  );

  // Catches: the revision checked only before the write, so a change committed while the write
  // waits on the row is overwritten (updatedAt dropped from the conditional update).
  postgresTest(
    "a write waiting on the session's row refuses a change committed meanwhile",
    async ({ prisma }) => {
      const s = await seed(prisma);

      const outcomes: Record<string, unknown> = {};
      for (const [tool, extra] of WRITES) {
        const session = await s.addSession(s.prod);
        const args = { sessionId: session.friendlyId, ...extra };
        await expectPending(s.call(tool, args));
        await approveAll();
        let running: Promise<Result> | undefined;
        await prisma.$transaction(
          async (tx) => {
            await tx.$queryRaw`SELECT id FROM "Session" WHERE id = ${session.id} FOR UPDATE`;
            await tx.session.update({
              where: { id: session.id },
              data: { expiresAt: new Date("2099-01-01T00:00:00Z") },
            });
            running = s.call(tool, args);
            running.catch(() => undefined);
            await waitForLockWait(prisma);
          },
          { timeout: 30_000 }
        );
        const result = await running!;
        const after = await prisma.session.findFirstOrThrow({ where: { id: session.id } });
        outcomes[tool] = {
          stale: STALE.test(textOf(result)),
          tags: after.tags,
          closedAt: after.closedAt,
        };
      }

      expect(outcomes).toEqual({
        update_session: { stale: true, tags: [], closedAt: null },
        close_session: { stale: true, tags: [], closedAt: null },
      });
    }
  );
});
