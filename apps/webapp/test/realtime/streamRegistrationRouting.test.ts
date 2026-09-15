import { heteroPostgresTest, redisTest } from "@internal/testcontainers";
import { PostgresRunStore } from "@internal/run-store";
import type { PrismaClient } from "@trigger.dev/database";
import Redis from "ioredis";
import { describe, expect } from "vitest";
import { RedisRealtimeStreams } from "~/services/realtime/redisRealtimeStreams.server.js";

// Seeds organization -> project -> runtimeEnvironment -> taskRun on the given prisma client.
// Mirrors the route's target run: a V2 run with an (optionally completed) lifecycle and an
// initially-empty realtimeStreams array.
async function seedRun(
  prisma: PrismaClient,
  params: {
    runId: string;
    slugSuffix: string;
    completedAt?: Date;
  }
) {
  const organization = await prisma.organization.create({
    data: {
      title: "Test Organization",
      slug: `test-organization-${params.slugSuffix}`,
    },
  });

  const project = await prisma.project.create({
    data: {
      name: "Test Project",
      slug: `test-project-${params.slugSuffix}`,
      externalRef: `proj_${params.slugSuffix}`,
      organizationId: organization.id,
    },
  });

  const environment = await prisma.runtimeEnvironment.create({
    data: {
      type: "DEVELOPMENT",
      slug: "dev",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_dev_apikey_${params.slugSuffix}`,
      pkApiKey: `pk_dev_apikey_${params.slugSuffix}`,
      shortcode: `short_code_${params.slugSuffix}`,
    },
  });

  await prisma.taskRun.create({
    data: {
      id: params.runId,
      engine: "V2",
      status: "PENDING",
      friendlyId: `run_friendly_${params.slugSuffix}`,
      runtimeEnvironmentId: environment.id,
      environmentType: "DEVELOPMENT",
      organizationId: organization.id,
      projectId: project.id,
      taskIdentifier: "my-task",
      payload: "{}",
      payloadType: "application/json",
      traceContext: {},
      traceId: `trace_${params.runId}`,
      spanId: `span_${params.runId}`,
      queue: "task/my-task",
      isTest: false,
      taskEventStore: "taskEvent",
      depth: 0,
      ...(params.completedAt !== undefined && { completedAt: params.completedAt }),
    },
  });

  return { organization, project, environment };
}

// The exact routed sequence performed by realtime.v1.streams.$runId.$target.$streamId(.append) PUT:
// read the target via the store, then push the streamId iff it is not already present and the run
// is not completed. Driving this against the store is the routed seam (no engine instance required).
async function routedRegisterStream(
  store: PostgresRunStore,
  client: PrismaClient,
  runId: string,
  streamId: string
): Promise<{ pushed: boolean }> {
  const target = await store.findRun(
    { id: runId },
    {
      select: {
        id: true,
        realtimeStreams: true,
        realtimeStreamsVersion: true,
        completedAt: true,
      },
    },
    client
  );

  if (!target) {
    throw new Error("Run not found");
  }

  // Completed-run guard (route returns 400 here).
  if (target.completedAt) {
    return { pushed: false };
  }

  if (!target.realtimeStreams.includes(streamId)) {
    await store.pushRealtimeStream(target.id, streamId, client);
    return { pushed: true };
  }

  return { pushed: false };
}

describe("realtime stream registration — run-ops store routed writes", () => {
  heteroPostgresTest(
    "push routes to run-ops store for a run on the new DB",
    { timeout: 60_000 },
    async ({ prisma17, prisma14 }) => {
      // The run-ops store owns the PG17 (new) DB.
      const store = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });

      const runId = "run_routed_push_new_db";
      await seedRun(prisma17, { runId, slugSuffix: "push17" });

      const streamId = "stream-abc";
      const result = await routedRegisterStream(store, prisma17, runId, streamId);

      expect(result.pushed).toBe(true);

      // Write landed on the new (PG17) DB.
      const onNewDb = await prisma17.taskRun.findFirst({
        where: { id: runId },
        select: { realtimeStreams: true },
      });
      expect(onNewDb?.realtimeStreams).toContain(streamId);

      // Write is isolated to the new DB — the legacy (PG14) DB carries no run with that streamId.
      const onLegacyDb = await prisma14.taskRun.findFirst({
        where: { realtimeStreams: { has: streamId } },
        select: { id: true },
      });
      expect(onLegacyDb).toBeNull();
    }
  );

  heteroPostgresTest(
    "idempotent — already-registered streamId issues no second write",
    { timeout: 60_000 },
    async ({ prisma17 }) => {
      const store = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });

      const runId = "run_routed_push_idempotent";
      await seedRun(prisma17, { runId, slugSuffix: "idem17" });

      const streamId = "stream-once";

      const first = await routedRegisterStream(store, prisma17, runId, streamId);
      expect(first.pushed).toBe(true);

      const second = await routedRegisterStream(store, prisma17, runId, streamId);
      // The includes() guard skipped the second push.
      expect(second.pushed).toBe(false);

      const row = await prisma17.taskRun.findFirst({
        where: { id: runId },
        select: { realtimeStreams: true },
      });
      // Exactly one entry — no duplicate appended.
      expect(row?.realtimeStreams).toEqual([streamId]);
      expect(row?.realtimeStreams).toHaveLength(1);
    }
  );

  heteroPostgresTest(
    "completed run guard issues no push",
    { timeout: 60_000 },
    async ({ prisma17 }) => {
      const store = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });

      const runId = "run_routed_push_completed";
      await seedRun(prisma17, {
        runId,
        slugSuffix: "completed17",
        completedAt: new Date("2026-06-01T00:00:00.000Z"),
      });

      const streamId = "stream-late";
      const result = await routedRegisterStream(store, prisma17, runId, streamId);

      // The completedAt guard blocks the push (route returns 400).
      expect(result.pushed).toBe(false);

      const row = await prisma17.taskRun.findFirst({
        where: { id: runId },
        select: { realtimeStreams: true },
      });
      expect(row?.realtimeStreams).toEqual([]);
    }
  );

  redisTest(
    "chunks flow — stream attaches and chunks are ingested",
    { timeout: 30_000 },
    async ({ redisOptions }) => {
      const redis = new Redis(redisOptions);
      const streams = new RedisRealtimeStreams({ redis: redisOptions });

      const runId = "run_chunks_flow";
      const streamId = "registered-stream";

      const chunks = [
        JSON.stringify({ chunk: 0, data: "chunk 0" }),
        JSON.stringify({ chunk: 1, data: "chunk 1" }),
        JSON.stringify({ chunk: 2, data: "chunk 2" }),
      ];

      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(encoder.encode(chunk + "\n"));
          }
          controller.close();
        },
      });

      const response = await streams.ingestData(stream, runId, streamId, "default");
      expect(response.status).toBe(200);

      const streamKey = `stream:${runId}:${streamId}`;
      const entries = await redis.xrange(streamKey, "-", "+");
      expect(entries.length).toBe(3);

      const lastChunkIndex = await streams.getLastChunkIndex(runId, streamId, "default");
      expect(lastChunkIndex).toBe(2);

      await redis.del(streamKey);
      await redis.quit();
    }
  );
});
