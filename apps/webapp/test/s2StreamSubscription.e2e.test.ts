import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createS2Container, type StartedS2Container } from "@internal/testcontainers/webapp";
import { S2RealtimeStreams } from "~/services/realtime/s2realtimeStreams.server";
import { S2FaultProxy } from "./helpers/s2FaultProxy";

const creationErrors = [
  { status: 409, code: undefined },
  { status: 404, code: "stream_not_found" },
];

const terminalErrors = [
  { status: 401, code: "authn" },
  { status: 403, code: "permission_denied" },
  { status: 404, code: "basin_not_found" },
  { status: 404, code: "access_token_not_found" },
  { status: 404, code: undefined },
  { status: 404, code: "unknown" },
];

describe("S2 subscription handshake", () => {
  let s2: StartedS2Container;
  let streams: S2RealtimeStreams;
  const proxy = new S2FaultProxy();

  beforeAll(async () => {
    s2 = await createS2Container();
    const endpoint = await proxy.start();
    proxy.setTarget(s2.endpoint);
    streams = new S2RealtimeStreams({
      endpoint,
      basin: s2.basin,
      accessToken: "unused",
      s2WaitSeconds: 0,
    });
  }, 60_000);

  afterAll(async () => {
    await proxy.stop();
    await s2?.container.stop();
  });

  function subscribe(session: string, signal = AbortSignal.timeout(5_000), lastEventId?: string) {
    return streams.streamResponseFromSessionStream(
      new Request("http://localhost/session"),
      session,
      "out",
      signal,
      { lastEventId }
    );
  }

  it.each(creationErrors)(
    "retries HTTP $status ($code) without losing the requested resume position",
    async ({ status, code }) => {
      const session = randomUUID();
      await streams.appendPartToSessionStream("first", "p0", session, "out");
      await streams.appendPartToSessionStream("second", "p1", session, "out");
      proxy.rejectNextRead(session, status, 2, code);

      const response = await subscribe(session, undefined, "0");
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(response.headers.get("X-Stream-Version")).toBe("v2");
      expect(body).toContain("second");
      expect(body).not.toContain("first");
      expect(proxy.injected.filter((path) => path.includes(session))).toHaveLength(2);
    }
  );

  it.each(creationErrors)(
    "fails after four attempts if HTTP $status ($code) persists",
    async ({ status, code }) => {
      const session = randomUUID();
      proxy.rejectNextRead(session, status, 10, code);
      await expect(subscribe(session)).rejects.toThrow(`S2 stream failed: ${status}`);
      expect(proxy.injected.filter((path) => path.includes(session))).toHaveLength(4);
    }
  );

  it.each(creationErrors)(
    "retries non-blocking HTTP $status ($code) without losing the requested resume position",
    async ({ status, code }) => {
      const session = randomUUID();
      const channel = "updates";
      await streams.appendPartToSessionStream("first", "p0", session, "out", channel);
      await streams.appendPartToSessionStream("second", "p1", session, "out", channel);
      proxy.rejectNextRead(session, status, 2, code);

      const records = await streams.readSessionStreamRecords(session, "out", 0, channel);

      expect(records.map(({ data, id, seqNum }) => ({ data, id, seqNum }))).toEqual([
        { data: "second", id: "p1", seqNum: 1 },
      ]);
      expect(proxy.injected.filter((path) => path.includes(session))).toHaveLength(2);
    }
  );

  it.each([
    { status: 409, attempts: 3, code: undefined },
    ...terminalErrors.map((error) => ({ ...error, attempts: 1 })),
  ])(
    "bounds non-blocking reads to $attempts attempts for HTTP $status ($code)",
    async ({ status, attempts, code }) => {
      const run = randomUUID();
      proxy.rejectNextRead(run, status, 10, code);

      await expect(streams.readRecords(run, "input")).rejects.toThrow(
        `S2 readRecords failed: ${status}`
      );
      expect(proxy.injected.filter((path) => path.includes(run))).toHaveLength(attempts);
    }
  );

  it("returns no records only after bounded retries for a missing stream", async () => {
    const session = randomUUID();
    proxy.rejectNextRead(session, 404, 10, "stream_not_found");

    expect(await streams.readSessionStreamRecords(session, "in")).toEqual([]);
    expect(proxy.injected.filter((path) => path.includes(session))).toHaveLength(3);
  });

  it("opens concurrent subscriptions to previously unwritten streams", async () => {
    for (let round = 0; round < 8; round++) {
      const session = randomUUID();
      const statuses = await Promise.all(
        Array.from({ length: 8 }, async () => {
          const response = await subscribe(session);
          await response.text();
          return response.status;
        })
      );
      expect(statuses).toEqual(Array(8).fill(200));
    }
  });

  it.each(terminalErrors)("does not retry HTTP $status ($code)", async ({ status, code }) => {
    const session = randomUUID();
    proxy.rejectNextRead(session, status, 10, code);
    await expect(subscribe(session)).rejects.toThrow(`S2 stream failed: ${status}`);
    expect(proxy.injected.filter((path) => path.includes(session))).toHaveLength(1);
  });

  it.each(creationErrors)(
    "stops retrying HTTP $status ($code) when the subscriber disconnects during backoff",
    async ({ status, code }) => {
      const session = randomUUID();
      const abort = new AbortController();
      proxy.rejectNextRead(session, status, 10, code);
      const result = subscribe(session, abort.signal).catch((error: unknown) => error);
      await expect.poll(() => proxy.injected.some((path) => path.includes(session))).toBe(true);
      abort.abort();
      expect(await result).toMatchObject({ name: "AbortError" });
      const attempts = proxy.injected.filter((path) => path.includes(session)).length;
      // Prove no new request is sent after cancellation, across the first retry delay.
      await setTimeout(150);
      expect(proxy.injected.filter((path) => path.includes(session))).toHaveLength(attempts);
    }
  );
});
