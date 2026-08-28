/**
 * Full-stack e2e for the per-org-basin configuration: S2 credentials present,
 * no global basin, so whether a run can use v2 depends entirely on whether its
 * organization has been provisioned one.
 *
 * The sibling `sessionRunStreamsBackend` e2e runs with a global basin set,
 * which makes every basin value work and hides this whole class of bug. Here a
 * run stamped v2 without a resolvable basin is not a degraded experience, it
 * throws on every stream operation for the life of the run, so both directions
 * are asserted: a provisioned organization reaches S2, and an unprovisioned one
 * degrades to v1 and keeps working on Redis.
 *
 * Scope: both cases assert run-scoped streams only. Neither drives a session
 * channel, so neither says anything about `.in`/`.out`. That matters for the
 * unprovisioned case, where the session's own channels cannot resolve a basin
 * at all and fail: the run degrading to v1 is what keeps working there, not the
 * session. Do not read these as evidence that a session is healthy.
 *
 * Which basin the trigger path reads is pinned separately, by the swap case in
 * `realtimeServices.replicaLag.test.ts`, which asserts the organization's basin
 * reaches the resolver even when the session row carries one of its own.
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
  server = await startSessionStreamTestServer({
    extraEnv: {
      REALTIME_STREAMS_S2_BASIN: "",
      REALTIME_STREAMS_PER_ORG_BASINS_ENABLED: "true",
    },
  });
}, 180_000);

afterAll(async () => {
  await server?.stop();
}, 120_000);

const STREAM_ID = "frames";

/** Per-org basins drop the `org/{id}` segment; see `streamPrefixFor`. */
function perOrgStreamName(p: { envSlug: string; envId: string; runId: string }): string {
  return `env/${p.envSlug}/${p.envId}/runs/${p.runId}/${STREAM_ID}`;
}

function redisStreamKey(runId: string): string {
  return `tr:realtime:streams:stream:${runId}:${STREAM_ID}`;
}

async function s2HasRecords(basin: string, streamName: string): Promise<boolean> {
  const qs = new URLSearchParams({ seq_num: "0", clamp: "true", wait: "0" });
  const res = await fetch(
    `${server.s2.endpoint}/v1/streams/${encodeURIComponent(streamName)}/records?${qs}`,
    {
      headers: {
        Authorization: "Bearer ignored",
        Accept: "text/event-stream",
        "S2-Format": "raw",
        "S2-Basin": basin,
      },
    }
  );
  if (!res.ok) return false;
  return (await res.text()).includes(STREAM_ID);
}

async function createSessionRun(apiKey: string, taskIdentifier: string): Promise<string> {
  const res = await fetch(`${server.webapp.baseUrl}/api/v1/sessions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "chat.agent",
      externalId: `e2e-${randomBytes(6).toString("hex")}`,
      taskIdentifier,
      triggerConfig: { basePayload: {} },
    }),
  });
  expect(res.ok).toBe(true);
  return ((await res.json()) as { runId: string }).runId;
}

async function appendFrame(apiKey: string, runId: string): Promise<number> {
  const res = await fetch(
    `${server.webapp.baseUrl}/realtime/v1/streams/${runId}/self/${STREAM_ID}/append`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "text/plain",
        "X-Part-Id": STREAM_ID,
      },
      body: JSON.stringify({ frame: "a".repeat(1024) }),
    }
  );
  return res.status;
}

describe("session runs with per-org basins and no global basin", () => {
  it("reaches S2 for a provisioned organization", async () => {
    const { organization, environment, apiKey } = await seedTestEnvironment(server.prisma);
    const basin = server.s2.basin;

    await server.prisma.organization.update({
      where: { id: organization.id },
      data: { streamBasinName: basin },
    });

    const runId = await createSessionRun(apiKey, "e2e-per-org-provisioned");

    const run = await server.prisma.taskRun.findFirstOrThrow({
      where: { friendlyId: runId },
      select: { realtimeStreamsVersion: true, streamBasinName: true },
    });

    expect(await appendFrame(apiKey, runId)).toBe(200);

    const redis = new Redis({ host: server.redis.host, port: server.redis.port });
    let observed;
    try {
      observed = {
        version: run.realtimeStreamsVersion,
        runBasin: run.streamBasinName,
        inS2: await s2HasRecords(
          basin,
          perOrgStreamName({ envSlug: environment.slug, envId: environment.id, runId })
        ),
        keyInRedis: (await redis.exists(redisStreamKey(runId))) === 1,
      };
    } finally {
      redis.disconnect();
    }

    expect(observed).toEqual({ version: "v2", runBasin: basin, inS2: true, keyInRedis: false });
  });

  it("degrades to v1 for an unprovisioned organization, keeping its run-scoped streams usable", async () => {
    const { organization, apiKey } = await seedTestEnvironment(server.prisma);

    await server.prisma.organization.update({
      where: { id: organization.id },
      data: { streamBasinName: null },
    });

    const runId = await createSessionRun(apiKey, "e2e-per-org-unprovisioned");

    const run = await server.prisma.taskRun.findFirstOrThrow({
      where: { friendlyId: runId },
      select: { realtimeStreamsVersion: true, streamBasinName: true },
    });

    expect(await appendFrame(apiKey, runId)).toBe(200);

    const redis = new Redis({ host: server.redis.host, port: server.redis.port });
    let observed;
    try {
      observed = {
        version: run.realtimeStreamsVersion,
        runBasin: run.streamBasinName,
        keyInRedis: (await redis.exists(redisStreamKey(runId))) === 1,
      };
    } finally {
      redis.disconnect();
    }

    expect(observed).toEqual({ version: "v1", runBasin: null, keyInRedis: true });
  });
});
