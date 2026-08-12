/**
 * Full-stack e2e for which realtime streams backend a Session's run lands on.
 *
 * Boots the real webapp + Postgres + Redis + s2-lite (via
 * startSessionStreamTestServer), creates a Session through the public API so
 * the run is triggered by the real `sessionRunManager` path, then appends to a
 * run-scoped stream exactly as `streams.append()` does and checks where the
 * bytes actually went.
 *
 * The harness starts the webapp with `REALTIME_STREAMS_DEFAULT_VERSION: "v2"`
 * and a live S2, so a run landing on v1 here is not a configuration gap. It
 * means the trigger path never asked, and fell through to the
 * `realtimeStreamsVersion` column default.
 *
 * Requires a pre-built webapp: pnpm run build --filter webapp
 */
import { randomBytes } from "crypto";
import Redis from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SessionStreamTestServer } from "@internal/testcontainers/webapp";
import { startSessionStreamTestServer } from "@internal/testcontainers/webapp";
import { seedTestEnvironment } from "./helpers/seedTestEnvironment";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

let server: SessionStreamTestServer;

beforeAll(async () => {
  server = await startSessionStreamTestServer();
}, 180_000);

afterAll(async () => {
  await server?.stop();
}, 120_000);

const STREAM_ID = "frames";
const PART_ID = "part";
const FRAME_BYTES = 250 * 1024;
const FRAME_COUNT = 8;

/** Mirrors `S2RealtimeStreams.toStreamName` on the shared-basin prefix. */
function runStreamName(p: {
  orgId: string;
  envSlug: string;
  envId: string;
  runId: string;
  streamId: string;
}): string {
  return `org/${p.orgId}/env/${p.envSlug}/${p.envId}/runs/${p.runId}/${p.streamId}`;
}

/** Mirrors the `keyPrefix` + key shape in `v1StreamsGlobal` / `RedisRealtimeStreams`. */
function redisStreamKey(runId: string, streamId: string): string {
  return `tr:realtime:streams:stream:${runId}:${streamId}`;
}

function framesFound(body: string): number {
  return Array.from({ length: FRAME_COUNT }, (_, i) => `${PART_ID}-${i}`).filter((id) =>
    body.includes(id)
  ).length;
}

async function s2Body(streamName: string): Promise<string> {
  const qs = new URLSearchParams({ seq_num: "0", clamp: "true", wait: "0" });
  const res = await fetch(
    `${server.s2.endpoint}/v1/streams/${encodeURIComponent(streamName)}/records?${qs}`,
    {
      headers: {
        Authorization: "Bearer ignored",
        Accept: "text/event-stream",
        "S2-Format": "raw",
        "S2-Basin": server.s2.basin,
      },
    }
  );

  if (res.status === 404) return "";
  expect(res.ok).toBe(true);

  return res.text();
}

describe("session runs and the realtime streams backend", () => {
  it("stamps the run v2 and routes a run-scoped stream to S2, not Redis", async () => {
    const { organization, environment, apiKey } = await seedTestEnvironment(server.prisma);

    const createRes = await fetch(`${server.webapp.baseUrl}/api/v1/sessions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "chat.agent",
        externalId: `e2e-${randomBytes(6).toString("hex")}`,
        taskIdentifier: "e2e-browser-agent",
        triggerConfig: { basePayload: {} },
      }),
    });

    expect(createRes.ok).toBe(true);
    const created = (await createRes.json()) as { runId: string };
    expect(created.runId).toBeTruthy();

    const run = await server.prisma.taskRun.findFirstOrThrow({
      where: { friendlyId: created.runId },
      select: { realtimeStreamsVersion: true },
    });

    const appendStatuses: number[] = [];
    for (let i = 0; i < FRAME_COUNT; i++) {
      const res = await fetch(
        `${server.webapp.baseUrl}/realtime/v1/streams/${created.runId}/self/${STREAM_ID}/append`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "text/plain",
            "X-Part-Id": `${PART_ID}-${i}`,
          },
          body: JSON.stringify({ i, frame: "a".repeat(FRAME_BYTES) }),
        }
      );
      appendStatuses.push(res.status);
    }

    expect(appendStatuses).toEqual(Array.from({ length: FRAME_COUNT }, () => 200));

    const streamName = runStreamName({
      orgId: organization.id,
      envSlug: environment.slug,
      envId: environment.id,
      runId: created.runId,
      streamId: STREAM_ID,
    });
    const redis = new Redis({ host: server.redis.host, port: server.redis.port });
    let observed: { version: string; framesInS2: number; keyInRedis: boolean };
    try {
      observed = {
        version: run.realtimeStreamsVersion,
        framesInS2: framesFound(await s2Body(streamName)),
        keyInRedis: (await redis.exists(redisStreamKey(created.runId, STREAM_ID))) === 1,
      };
    } finally {
      redis.disconnect();
    }

    expect(observed).toEqual({ version: "v2", framesInS2: FRAME_COUNT, keyInRedis: false });
  });
});
