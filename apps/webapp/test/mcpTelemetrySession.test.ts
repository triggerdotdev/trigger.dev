import { redisTest } from "@internal/testcontainers";
import { Redis } from "ioredis";
import { createServer, type AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import {
  assembleStitchedEvents,
  createToolCallReporter,
  type TelemetryEvent,
} from "~/mcp/gate/reportToolCall.server";
import {
  createTelemetrySessionStore,
  TELEMETRY_SESSION_REDIS_LIMITS,
  telemetryClientKey,
  warmTelemetrySessionStore,
  type TelemetrySessionStore,
} from "~/mcp/telemetrySessionStore";

vi.setConfig({ testTimeout: 60_000 });

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("telemetry session store", () => {
  // Catches: concurrent first calls each starting their own session.
  redisTest("gives 20 concurrent first calls one id and one start", async ({ redisOptions }) => {
    const redis = new Redis(redisOptions);
    const store = createTelemetrySessionStore(redis);

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => store.resolve("u1", "c1", `mcps_${i}`))
    );

    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(results.filter((r) => r.started)).toHaveLength(1);
    await redis.quit();
  });

  // Catches: the window not sliding, so a busy session is cut at the first TTL.
  redisTest("keeps the session while calls stay within the window", async ({ redisOptions }) => {
    const redis = new Redis(redisOptions);
    const store = createTelemetrySessionStore(redis, 300);

    const first = await store.resolve("u1", "c1", "mcps_a");
    await pause(200);
    const second = await store.resolve("u1", "c1", "mcps_b");
    await pause(200);
    const third = await store.resolve("u1", "c1", "mcps_c");

    expect([first.id, second.id, third.id]).toEqual(["mcps_a", "mcps_a", "mcps_a"]);
    await redis.quit();
  });

  redisTest("starts a new session after the window passes", async ({ redisOptions }) => {
    const redis = new Redis(redisOptions);
    const store = createTelemetrySessionStore(redis, 100);

    await store.resolve("u1", "c1", "mcps_a");
    await pause(250);

    expect(await store.resolve("u1", "c1", "mcps_b")).toEqual({ id: "mcps_b", started: true });
    await redis.quit();
  });

  redisTest("keeps users and clients apart", async ({ redisOptions }) => {
    const redis = new Redis(redisOptions);
    const store = createTelemetrySessionStore(redis);

    const ids = await Promise.all([
      store.resolve("u1", "c1", "mcps_a"),
      store.resolve("u2", "c1", "mcps_b"),
      store.resolve("u1", "c2", "mcps_c"),
    ]);

    expect(ids.map((r) => r.id)).toEqual(["mcps_a", "mcps_b", "mcps_c"]);
    await redis.quit();
  });
});

describe("telemetry session store under a stalled Redis", () => {
  // Catches: no command timeout, so stalled commands queue behind a 500 ms bound that only stops waiting.
  redisTest("rejects the command near the bound", async ({ redisOptions }) => {
    const admin = new Redis(redisOptions);
    const client = new Redis({ ...redisOptions, ...TELEMETRY_SESSION_REDIS_LIMITS });
    try {
      const store = createTelemetrySessionStore(client);
      // Without an offline queue the first calls fail until the connection is up.
      let warm: { id: string } | undefined;
      for (let i = 0; i < 40 && !warm; i++) {
        warm = await store.resolve("u1", "warm", "mcps_w").catch(() => undefined);
        if (!warm) await pause(50);
      }
      expect(warm?.id).toBe("mcps_w");

      await admin.client("PAUSE", 1500, "ALL");
      const startedAt = Date.now();
      await expect(store.resolve("u1", "c1", "mcps_a")).rejects.toThrow();

      expect(Date.now() - startedAt).toBeLessThan(1200);
      await pause(1500);
    } finally {
      client.disconnect();
      admin.disconnect();
    }
  });
});

describe("telemetry session store while Redis is unreachable", () => {
  // Catches: commands queueing offline and replaying in a burst once Redis comes back.
  it("rejects at once instead of queueing", async () => {
    const silent = createServer().listen(0);
    await new Promise((resolve) => silent.once("listening", resolve));
    const client = new Redis({
      host: "127.0.0.1",
      port: (silent.address() as AddressInfo).port,
      retryStrategy: () => null,
      ...TELEMETRY_SESSION_REDIS_LIMITS,
    });
    client.on("error", () => {});
    try {
      const startedAt = Date.now();

      await expect(
        createTelemetrySessionStore(client).resolve("u1", "c1", "mcps_a")
      ).rejects.toThrow();

      expect(Date.now() - startedAt).toBeLessThan(300);
    } finally {
      client.disconnect();
      silent.close();
    }
  });
});

describe("warmTelemetrySessionStore", () => {
  // Catches: opening the Redis connection on deployments that never send these analytics.
  it.each([
    [false, 0],
    [true, 1],
  ])("with analytics enabled=%s it opens the store %s time(s)", (enabled, opened) => {
    let opens = 0;
    warmTelemetrySessionStore({ enabled: () => enabled, open: () => opens++ });
    expect(opens).toBe(opened);
  });

  it("does not throw when opening fails", () => {
    expect(() =>
      warmTelemetrySessionStore({
        enabled: () => true,
        open: () => {
          throw new Error("down");
        },
      })
    ).not.toThrow();
  });
});

describe("telemetryClientKey", () => {
  it("never puts client text in the key", () => {
    expect(telemetryClientKey({ clientName: "a:b\nc" })).toMatch(/^[0-9a-f]{16}$/);
    expect(telemetryClientKey({ userAgent: "ua" })).toMatch(/^[0-9a-f]{16}$/);
    expect(telemetryClientKey({})).toBe("unknown");
  });
});

const call = {
  userId: "u1",
  properties: { $mcp_tool_name: "query" },
  stitch: { client: { clientName: "claude-code" }, userAgent: "ua" },
};

describe("assembleStitchedEvents", () => {
  // Catches: a stitched session never announcing itself with an initialize.
  it("puts the initialize before its tool call when a session starts", () => {
    const at = new Date("2026-01-01T00:00:00Z");
    const events = assembleStitchedEvents({ call, session: { id: "mcps_a", started: true }, at });

    expect(events.map((e) => e.event)).toEqual(["$mcp_initialize", "$mcp_tool_call"]);
    expect(events[0]!.timestamp.getTime()).toBeLessThanOrEqual(events[1]!.timestamp.getTime());
    expect(events[0]!.properties).toMatchObject({
      $session_id: "mcps_a",
      $mcp_client_name: "claude-code",
      sessionSource: "inactivity",
    });
    expect(events[1]!.properties).toMatchObject({
      $mcp_session_id: "mcps_a",
      sessionSource: "inactivity",
    });
  });

  it("sends only the tool call, without an id, when there is no session", () => {
    const events = assembleStitchedEvents({ call, at: new Date() });
    expect(events.map((e) => e.event)).toEqual(["$mcp_tool_call"]);
    expect(events[0]!.properties.$session_id).toBeUndefined();
  });
});

describe("createToolCallReporter", () => {
  const run = async (store: TelemetrySessionStore, timeoutMs = 20) => {
    const sent: TelemetryEvent[] = [];
    const report = createToolCallReporter({
      enabled: () => true,
      store: () => store,
      send: (_call, event) => sent.push(event),
      timeoutMs,
    });
    await expect(report(call)).resolves.toBeUndefined();
    return sent;
  };

  // Catches: a failing or hanging store losing the tool call or rejecting into the request.
  it.each([
    ["failing", { resolve: () => Promise.reject(new Error("down")) }],
    ["hanging", { resolve: () => new Promise<never>(() => {}) }],
  ])("still sends the tool call without a session when the store is %s", async (_n, store) => {
    const sent = await run(store);

    expect(sent.map((e) => e.event)).toEqual(["$mcp_tool_call"]);
    expect(sent[0]!.properties.$session_id).toBeUndefined();
  });

  // Catches: touching Redis when remote analytics would not be sent.
  it("does not touch the store when disabled", async () => {
    let resolves = 0;
    await createToolCallReporter({
      enabled: () => false,
      store: () => ({ resolve: async () => (resolves++, { id: "mcps_a", started: true }) }),
      send: () => {},
    })(call);

    expect(resolves).toBe(0);
  });
});
