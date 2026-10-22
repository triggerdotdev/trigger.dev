/**
 * Full-stack e2e for S2 reads that fail after the response has started.
 *
 * S2 reports such a failure (a frontend draining during a deploy, an expired
 * token, transient unavailability) as `event: error` followed by a normal end
 * of the response, without `[DONE]`. Boots the real webapp + Postgres + Redis +
 * s2-lite with an `S2FaultProxy` between the webapp and s2-lite that injects
 * exactly that, then checks every kind of reader recovers or reports it:
 *
 * - `SSEStreamSubscription` on a session `.out` (the client every realtime
 *   reader is built on: run streams, React hooks, chat transports, dashboard)
 * - a run-scoped stream, on the URL `SSEStreamSubscriptionFactory` builds for
 *   `runs.subscribeToRun` with streams
 * - `AgentChat.reconnect()` when the error arrives before any record
 * - the server-side record read behind the `/records` route, which retries
 * - the session and input stream `.wait()` race checks, which must still find a
 *   record sent before the wait registered
 *
 * Requires a pre-built webapp: pnpm run build --filter webapp
 */
import { randomBytes } from "crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { apiClientManager, SSEStreamSubscription, type SSEStreamPart } from "@trigger.dev/core/v3";
import { runs } from "@trigger.dev/sdk";
import { AgentChat } from "@trigger.dev/sdk/chat";
import type { SessionStreamTestServer } from "@internal/testcontainers/webapp";
import { startSessionStreamTestServer } from "@internal/testcontainers/webapp";
import { seedTestEnvironment } from "./helpers/seedTestEnvironment";
import { S2FaultProxy } from "./helpers/s2FaultProxy";
import {
  isTurnComplete,
  mintSessionToken,
  SessionStreamProducer,
  sessionStreamName,
} from "./helpers/sessionStream";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

let server: SessionStreamTestServer;
const proxy = new S2FaultProxy();

beforeAll(async () => {
  const proxyEndpoint = await proxy.start();
  server = await startSessionStreamTestServer({
    extraEnv: {
      REALTIME_STREAMS_S2_ENDPOINT: proxyEndpoint,
      REALTIME_BACKEND_NATIVE_ENABLED: "1",
      REALTIME_BACKEND_DEFAULT: "native",
    },
  });
  proxy.setTarget(server.s2.endpoint);
}, 180_000);

afterAll(async () => {
  await server?.stop();
  await proxy.stop();
}, 120_000);

async function setupSession() {
  const seeded = await seedTestEnvironment(server.prisma);
  const { organization, project, environment, apiKey } = seeded;
  const addressingKey = `sess-${randomBytes(6).toString("hex")}`;
  await server.prisma.session.create({
    data: {
      friendlyId: `session_${randomBytes(8).toString("hex")}`,
      externalId: addressingKey,
      type: "chat.agent",
      projectId: project.id,
      runtimeEnvironmentId: environment.id,
      environmentType: environment.type,
      organizationId: organization.id,
      taskIdentifier: "chat-agent",
      triggerConfig: { basePayload: {} },
    },
  });
  const token = await mintSessionToken({ apiKey, envId: environment.id, addressingKey });
  const producer = new SessionStreamProducer({
    endpoint: server.s2.endpoint,
    basin: server.s2.basin,
    streamName: sessionStreamName({
      orgId: organization.id,
      envSlug: environment.slug,
      envId: environment.id,
      addressingKey,
    }),
  });
  return { addressingKey, token, apiKey, producer, baseUrl: server.webapp.baseUrl };
}

/** Creates a Session through the public API, which also triggers its first run. */
async function createSessionRun() {
  const seeded = await seedTestEnvironment(server.prisma);
  const externalId = `e2e-${randomBytes(6).toString("hex")}`;
  const res = await fetch(`${server.webapp.baseUrl}/api/v1/sessions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${seeded.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "chat.agent",
      externalId,
      taskIdentifier: "e2e-s2-error-agent",
      triggerConfig: { basePayload: {} },
    }),
  });
  expect(res.ok).toBe(true);
  const { runId } = (await res.json()) as { runId: string };
  return { ...seeded, externalId, runId };
}

async function postJson(path: string, apiKey: string, body: unknown) {
  return fetch(`${server.webapp.baseUrl}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function findWaitpoint(friendlyId: string) {
  return server.prisma.waitpoint.findFirstOrThrow({
    where: { friendlyId },
    select: { status: true, output: true },
  });
}

type Read = { parts: SSEStreamPart[]; endedEarly: boolean };

/**
 * Drains one subscription (no resubscribe on close, unlike `collectSessionOut`,
 * which would hide a read that ends early). `onPart` can append more records
 * once the reader is mid-stream. Stops at `until` or the deadline.
 */
async function readOne(
  subscription: SSEStreamSubscription,
  opts: {
    until: (parts: SSEStreamPart[]) => boolean;
    onPart?: (part: SSEStreamPart) => Promise<void>;
    maxMs?: number;
  }
): Promise<Read> {
  const reader = (await subscription.subscribe()).getReader();
  const parts: SSEStreamPart[] = [];
  const deadline = performance.now() + (opts.maxMs ?? 20_000);
  let endedEarly = false;
  try {
    while (!opts.until(parts)) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) break;
      const next = await Promise.race([
        reader.read(),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), remaining)),
      ]);
      if (next === "timeout") break;
      if (next.done) {
        endedEarly = true;
        break;
      }
      parts.push(next.value);
      await opts.onPart?.(next.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return { parts, endedEarly };
}

function dataValues(parts: SSEStreamPart[]): number[] {
  return parts
    .filter((part) => !isTurnComplete(part as never) && part.chunk != null)
    .map((part) => (part.chunk as { n: number }).n);
}

describe("S2 error events e2e", () => {
  it("a session .out subscription resumes after S2 fails the read mid-stream", async () => {
    const { addressingKey, token, producer, baseUrl } = await setupSession();
    await producer.appendData({ n: 0 }, "p0");
    await producer.appendData({ n: 1 }, "p1");
    proxy.failNextRead(`sessions/${addressingKey}/out`, 1);

    const subscription = new SSEStreamSubscription(
      `${baseUrl}/realtime/v1/sessions/${encodeURIComponent(addressingKey)}/out`,
      { headers: { Authorization: `Bearer ${token}` }, timeoutInSeconds: 30, retryDelayMs: 50 }
    );
    let appendedRest = false;
    const read = await readOne(subscription, {
      until: (parts) => parts.some((part) => isTurnComplete(part as never)),
      onPart: async (part) => {
        if (appendedRest || (part.chunk as { n?: number } | undefined)?.n !== 1) return;
        appendedRest = true;
        await producer.appendData({ n: 2 }, "p2");
        await producer.appendData({ n: 3 }, "p3");
        await producer.appendTurnComplete();
      },
    });

    expect(proxy.injected.filter((path) => path.includes(addressingKey))).toHaveLength(1);
    expect(read.endedEarly).toBe(false);
    expect(dataValues(read.parts)).toEqual([0, 1, 2, 3]);
    expect(read.parts.some((part) => isTurnComplete(part as never))).toBe(true);
  });

  it("a run stream subscription resumes after S2 fails the read mid-stream", async () => {
    const { apiKey, runId } = await createSessionRun();
    const baseUrl = server.webapp.baseUrl;
    const streamId = `frames-${randomBytes(4).toString("hex")}`;

    const append = async (i: number) => {
      const res = await fetch(`${baseUrl}/realtime/v1/streams/${runId}/self/${streamId}/append`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "text/plain",
          "X-Part-Id": `frame-${i}`,
        },
        body: JSON.stringify({ n: i }),
      });
      expect(res.status).toBe(200);
    };
    await append(0);
    await append(1);
    proxy.failNextRead(`runs/${runId}/${streamId}`, 1);

    const subscription = new SSEStreamSubscription(
      `${baseUrl}/realtime/v1/streams/${runId}/${streamId}`,
      { headers: { Authorization: `Bearer ${apiKey}` }, retryDelayMs: 50 }
    );
    let appendedRest = false;
    const read = await readOne(subscription, {
      until: (parts) => parts.length >= 4,
      onPart: async (part) => {
        if (appendedRest || part.recordId !== "frame-1") return;
        appendedRest = true;
        await append(2);
        await append(3);
      },
    });

    expect(proxy.injected.filter((path) => path.includes(runId))).toHaveLength(1);
    expect(read.endedEarly).toBe(false);
    expect(read.parts.map((part) => part.recordId)).toEqual([
      "frame-0",
      "frame-1",
      "frame-2",
      "frame-3",
    ]);
  });

  it("runs.subscribeToRun().withStreams() keeps a stream after S2 fails the read mid-stream", async () => {
    const { apiKey, runId } = await createSessionRun();
    const baseUrl = server.webapp.baseUrl;
    const streamId = `frames-${randomBytes(4).toString("hex")}`;

    const append = async (i: number) => {
      const res = await fetch(`${baseUrl}/realtime/v1/streams/${runId}/self/${streamId}/append`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "text/plain",
          "X-Part-Id": `frame-${i}`,
        },
        body: JSON.stringify({ n: i }),
      });
      expect(res.status).toBe(200);
    };
    await append(0);
    await append(1);
    proxy.failNextRead(`runs/${runId}/${streamId}`, 1);

    const values = await apiClientManager.runWithConfig(
      { baseURL: baseUrl, secretKey: apiKey },
      async () => {
        const subscription = runs.subscribeToRun(runId);
        const iterator = subscription.withStreams()[Symbol.asyncIterator]();
        const seen: number[] = [];
        const deadline = performance.now() + 20_000;
        let appendedRest = false;
        try {
          while (seen.length < 4) {
            const remaining = deadline - performance.now();
            if (remaining <= 0) break;
            const next = await Promise.race([
              iterator.next(),
              new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), remaining)),
            ]);
            if (next === "timeout" || next.done) break;
            if (next.value.type !== streamId) continue;
            const chunk = next.value.chunk as unknown;
            const { n } = (typeof chunk === "string" ? JSON.parse(chunk) : chunk) as { n: number };
            seen.push(n);
            if (!appendedRest && n === 1) {
              appendedRest = true;
              await append(2);
              await append(3);
            }
          }
        } finally {
          subscription.unsubscribe();
        }
        return seen;
      }
    );

    expect(proxy.injected.filter((path) => path.includes(`${runId}/${streamId}`))).toHaveLength(1);
    expect(values).toEqual([0, 1, 2, 3]);
  });

  it("AgentChat.reconnect() recovers when S2 fails the read before any record", async () => {
    const { addressingKey, apiKey, producer, baseUrl } = await setupSession();
    await producer.appendData({ type: "text-start", id: "part-1" }, "c0");
    await producer.appendData({ type: "text-delta", id: "part-1", delta: "hi" }, "c1");
    proxy.failNextRead(`sessions/${addressingKey}/out`, 0);

    const types = await apiClientManager.runWithConfig(
      { baseURL: baseUrl, secretKey: apiKey },
      async () => {
        const chat = new AgentChat({ agent: "chat-agent", id: addressingKey, session: {} });
        const stream = await chat.reconnect(AbortSignal.timeout(30_000));
        expect(stream).not.toBeNull();
        const reader = stream!.getReader();
        const seen: string[] = [];
        let appendedRest = false;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            seen.push(value.type);
            if (!appendedRest && value.type === "text-delta") {
              appendedRest = true;
              await producer.appendData({ type: "text-end", id: "part-1" }, "c2");
              await producer.appendTurnComplete();
            }
          }
        } finally {
          reader.releaseLock();
        }
        return seen;
      }
    );

    expect(proxy.injected.filter((path) => path.includes(addressingKey))).toHaveLength(1);
    expect(types).toEqual(["text-start", "text-delta", "text-end"]);
  });

  it("the /records read retries an S2 read that fails once", async () => {
    const { addressingKey, token, producer, baseUrl } = await setupSession();
    await producer.appendData({ n: 0 }, "p0");
    await producer.appendData({ n: 1 }, "p1");
    proxy.failNextRead(`sessions/${addressingKey}/out`, 0);

    const res = await fetch(
      `${baseUrl}/realtime/v1/sessions/${encodeURIComponent(addressingKey)}/out/records`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const body = await res.text();

    expect(proxy.injected.filter((path) => path.includes(addressingKey))).toHaveLength(1);
    expect(res.status, body).toBe(200);
    const { records } = JSON.parse(body) as { records: Array<{ seqNum: number }> };
    expect(records.map((record) => record.seqNum)).toEqual([0, 1]);
  });

  it("the /records read reports an S2 read failure that outlasts its retries", async () => {
    const { addressingKey, token, producer, baseUrl } = await setupSession();
    await producer.appendData({ n: 0 }, "p0");
    proxy.failNextRead(`sessions/${addressingKey}/out`, 0, { times: 10 });

    const res = await fetch(
      `${baseUrl}/realtime/v1/sessions/${encodeURIComponent(addressingKey)}/out/records`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const body = await res.text();

    expect(res.status, body).toBeGreaterThanOrEqual(500);
  });

  it.each([
    ["before any record", 0],
    ["after the waiting record", 1],
  ])(
    "a session .wait() race check finds an earlier send when S2 fails the read %s",
    async (_when, afterBatches) => {
      const { apiKey, runId, externalId, organization, environment } = await createSessionRun();
      const producer = new SessionStreamProducer({
        endpoint: server.s2.endpoint,
        basin: server.s2.basin,
        streamName: sessionStreamName({
          orgId: organization.id,
          envSlug: environment.slug,
          envId: environment.id,
          addressingKey: externalId,
          io: "in",
        }),
      });
      await producer.appendData(JSON.stringify({ text: "sent before the wait" }), "m0");
      proxy.failNextRead(`sessions/${externalId}/in`, afterBatches);

      const res = await postJson(`/api/v1/runs/${runId}/session-streams/wait`, apiKey, {
        session: externalId,
        io: "in",
        timeout: "1h",
      });
      const body = await res.text();
      expect(res.status, body).toBe(200);
      const { waitpointId } = JSON.parse(body) as { waitpointId: string };

      expect(proxy.injected.filter((path) => path.includes(externalId))).toHaveLength(1);
      const waitpoint = await findWaitpoint(waitpointId);
      expect(waitpoint.status).toBe("COMPLETED");
      expect(waitpoint.output).toContain("sent before the wait");
    }
  );

  it("an input stream .wait() race check finds an earlier send when S2 fails the read", async () => {
    const { apiKey, runId } = await createSessionRun();
    const streamId = `answers-${randomBytes(4).toString("hex")}`;

    const send = await postJson(`/realtime/v1/streams/${runId}/input/${streamId}`, apiKey, {
      data: { answer: "sent before the wait" },
    });
    expect(send.status).toBe(200);
    proxy.failNextRead(`runs/${runId}/$trigger.input:${streamId}`, 0);

    const res = await postJson(`/api/v1/runs/${runId}/input-streams/wait`, apiKey, {
      streamId,
      timeout: "1h",
    });
    const body = await res.text();
    expect(res.status, body).toBe(200);
    const { waitpointId } = JSON.parse(body) as { waitpointId: string };

    expect(proxy.injected.filter((path) => path.includes(runId))).toHaveLength(1);
    const waitpoint = await findWaitpoint(waitpointId);
    expect(waitpoint.status).toBe("COMPLETED");
    expect(waitpoint.output).toContain("sent before the wait");
  });
});
