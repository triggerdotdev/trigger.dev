/**
 * Full-stack session-stream e2e.
 *
 * Boots the real webapp + Postgres + Redis + s2-lite 0.40.0 (via
 * startSessionStreamTestServer), then drives the session `.out` wire protocol
 * directly: a producer appends records straight to S2 (the agent simulator),
 * and the client subscribes through the webapp SSE proxy using the real
 * `SSEStreamSubscription` from `@trigger.dev/core` — the same code the browser
 * runs, minus the DOM.
 *
 * Requires a pre-built webapp: pnpm run build --filter webapp
 */
import { randomBytes } from "crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SessionStreamInstance } from "@trigger.dev/core/v3";
import type { SessionStreamTestServer } from "@internal/testcontainers/webapp";
import { startSessionStreamTestServer } from "@internal/testcontainers/webapp";
import { seedTestEnvironment } from "./helpers/seedTestEnvironment";
import {
  appendInput,
  collectSessionOut,
  isTurnComplete,
  mintSessionToken,
  openChannelRaw,
  SessionStreamProducer,
  sessionStreamName,
} from "./helpers/sessionStream";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

let server: SessionStreamTestServer;

beforeAll(async () => {
  server = await startSessionStreamTestServer();
}, 180_000);

afterAll(async () => {
  await server?.stop();
}, 120_000);

async function setupSession() {
  const { organization, project, environment, apiKey } = await seedTestEnvironment(server.prisma);
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
  const streamName = sessionStreamName({
    orgId: organization.id,
    envSlug: environment.slug,
    envId: environment.id,
    addressingKey,
  });
  const producer = new SessionStreamProducer({
    endpoint: server.s2.endpoint,
    basin: server.s2.basin,
    streamName,
  });
  return { addressingKey, token, producer, streamName, baseUrl: server.webapp.baseUrl };
}

function readableFrom<T>(chunks: T[]): ReadableStream<T> {
  return new ReadableStream<T>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

describe("session stream e2e", () => {
  it("E1 basic: data records + turn-complete are delivered in order", async () => {
    const { addressingKey, token, producer, baseUrl } = await setupSession();

    await producer.appendData({ n: 0 }, "p0");
    await producer.appendData({ n: 1 }, "p1");
    await producer.appendData({ n: 2 }, "p2");
    await producer.appendTurnComplete();

    const { parts } = await collectSessionOut({
      baseUrl,
      addressingKey,
      token,
      until: (p) => p.some(isTurnComplete),
      maxMs: 20_000,
    });

    const dataChunks = parts
      .filter((p) => !isTurnComplete(p) && p.chunk != null)
      .map((p) => (p.chunk as { n: number }).n);

    expect(dataChunks).toEqual([0, 1, 2]);
    expect(parts.some(isTurnComplete)).toBe(true);

    const seqs = parts.map((p) => Number(p.id));
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it("E2 continuation: seq is monotonic across two turns on the same .out", async () => {
    const { addressingKey, token, producer, baseUrl } = await setupSession();

    await producer.appendData({ n: 0 }, "p0");
    await producer.appendTurnComplete();
    await producer.appendData({ n: 1 }, "p1");
    await producer.appendData({ n: 2 }, "p2");
    const tc2 = await producer.appendTurnComplete();

    const { parts } = await collectSessionOut({
      baseUrl,
      addressingKey,
      token,
      until: (p) => p.filter(isTurnComplete).length >= 2,
      maxMs: 20_000,
    });

    expect(parts.filter(isTurnComplete)).toHaveLength(2);
    const seqs = parts.map((p) => Number(p.id));
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(Math.max(...seqs)).toBe(tc2);
    const dataChunks = parts
      .filter((p) => !isTurnComplete(p) && p.chunk != null)
      .map((p) => (p.chunk as { n: number }).n);
    expect(dataChunks).toEqual([0, 1, 2]);
  });

  it("E5 no-dup reconnect: resume via Last-Event-ID delivers each record once", async () => {
    const { addressingKey, token, producer, baseUrl } = await setupSession();

    await producer.appendData({ n: 0 }, "p0");
    await producer.appendData({ n: 1 }, "p1");
    const s2 = await producer.appendData({ n: 2 }, "p2");

    const first = await collectSessionOut({
      baseUrl,
      addressingKey,
      token,
      until: (p) => p.filter((x) => x.chunk != null).length >= 3,
      maxMs: 20_000,
    });
    const firstSeqs = first.parts.map((p) => Number(p.id));
    expect(firstSeqs).toContain(s2);

    await producer.appendData({ n: 3 }, "p3");
    await producer.appendData({ n: 4 }, "p4");

    const second = await collectSessionOut({
      baseUrl,
      addressingKey,
      token,
      lastEventId: String(s2),
      until: (p) => p.filter((x) => x.chunk != null).length >= 2,
      maxMs: 20_000,
    });
    const secondSeqs = second.parts.map((p) => Number(p.id));

    const all = [...firstSeqs, ...secondSeqs];
    expect(new Set(all).size).toBe(all.length);
    const allData = [...first.parts, ...second.parts]
      .filter((p) => p.chunk != null)
      .map((p) => (p.chunk as { n: number }).n)
      .sort((a, b) => a - b);
    expect(allData).toEqual([0, 1, 2, 3, 4]);
  });

  it("E7 trim-at-tail: trim command record is filtered from the stream", async () => {
    const { addressingKey, token, producer, baseUrl } = await setupSession();

    await producer.appendData({ n: 0 }, "p0");
    const keep = await producer.appendData({ n: 1 }, "p1");
    await producer.appendTurnComplete();
    await producer.trim(keep);

    const { parts } = await collectSessionOut({
      baseUrl,
      addressingKey,
      token,
      until: (p) => p.some(isTurnComplete),
      maxMs: 15_000,
    });

    const commandRecords = parts.filter((p) => (p.headers ?? []).some(([k]) => k === ""));
    expect(commandRecords).toHaveLength(0);
    expect(parts.filter((p) => p.chunk != null).length).toBeGreaterThanOrEqual(1);
  });

  it("E8 in/append 413 for an oversized body still carries CORS headers", async () => {
    const { addressingKey, token, baseUrl } = await setupSession();

    const oversized = "x".repeat(2 * 1024 * 1024);
    const { status, acao } = await appendInput({
      baseUrl,
      addressingKey,
      token,
      origin: "http://example.com",
      body: JSON.stringify({ kind: "message", payload: { big: oversized } }),
    });

    expect(status).toBe(413);
    expect(acao).not.toBeNull();
  });

  it("E9 server peek fast-closes at a turn-complete tail with X-Session-Settled", async () => {
    const { addressingKey, token, producer, baseUrl } = await setupSession();

    await producer.appendData({ n: 0 }, "p0");
    const tc = await producer.appendTurnComplete();

    let result: Awaited<ReturnType<typeof openChannelRaw>> | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      result = await openChannelRaw({
        baseUrl,
        addressingKey,
        token,
        lastEventId: String(tc),
        peekSettled: true,
        timeoutInSeconds: 30,
        maxMs: 8_000,
      });
      if (result.status === 200 && result.sessionSettled === "true") break;
      await new Promise((r) => setTimeout(r, 500));
    }

    expect(result!.status).toBe(200);
    expect(result!.sessionSettled).toBe("true");
    expect(result!.closedMs).toBeLessThan(8_000);
  });

  /**
   * E10 head-start handover: the resume cursor the S2 stream writer reports
   * from `wait()` must point AT the last record it wrote, not one past it.
   * `chat.ln`'s warm process drains step 1 to `session.out`, hands that
   * cursor to the agent's resume subscribe, and the read proxy resumes from
   * `cursor + 1`. S2's append `end` is exclusive (last seq + 1), so if the
   * writer reports `end` the agent's first post-handover record is skipped.
   */
  it("E10 head-start handover cursor does not skip the first post-handover record", async () => {
    const { addressingKey, token, producer, streamName, baseUrl } = await setupSession();

    const writer = new SessionStreamInstance<{ n: number }>({
      apiClient: undefined as never,
      baseUrl,
      sessionId: addressingKey,
      io: "out",
      source: readableFrom([{ n: 0 }, { n: 1 }]),
      initializeSession: async () => ({
        headers: {
          "x-s2-access-token": "ignored",
          "x-s2-basin": server.s2.basin,
          "x-s2-stream-name": streamName,
          "x-s2-endpoint": server.s2.endpoint,
        },
      }),
    });

    const { lastEventId } = await writer.wait();
    expect(lastEventId).toBeDefined();

    const agentSeq = await producer.appendData({ n: 2 }, "agent-0");

    const { parts } = await collectSessionOut({
      baseUrl,
      addressingKey,
      token,
      lastEventId,
      until: (p) => p.some((x) => x.chunk != null),
      maxMs: 15_000,
    });

    const dataChunks = parts
      .filter((p) => p.chunk != null)
      .map((p) => (p.chunk as { n: number }).n);

    expect(dataChunks).toEqual([2]);
    expect(parts.map((p) => Number(p.id))).toContain(agentSeq);
  });

  it("E11 in/append delivers the record on the .in channel", async () => {
    const { addressingKey, token, baseUrl } = await setupSession();

    const payload = JSON.stringify({ kind: "message", text: "hello from client" });
    const appended = await appendInput({
      baseUrl,
      addressingKey,
      token,
      partId: "in-0",
      body: payload,
    });
    expect(appended.status).toBe(200);

    const { parts } = await collectSessionOut({
      baseUrl,
      addressingKey,
      token,
      io: "in",
      until: (p) => p.some((x) => x.chunk != null),
      maxMs: 15_000,
    });

    const got = parts.find((p) => p.chunk != null);
    expect(got).toBeTruthy();
    expect(String(got?.chunk)).toContain("hello from client");
  });

  it("E12 subscribe with an invalid token is rejected", async () => {
    const { addressingKey, baseUrl } = await setupSession();

    const { status } = await openChannelRaw({
      baseUrl,
      addressingKey,
      token: "tr_pub_invalid_not_a_real_token",
      maxMs: 5_000,
    });

    expect([401, 403]).toContain(status);
  });
});
