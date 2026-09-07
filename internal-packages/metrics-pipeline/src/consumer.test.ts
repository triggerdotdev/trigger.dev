import { createRedisClient } from "@internal/redis";
import { redisTest } from "@internal/testcontainers";
import { expect } from "vitest";
import { CachedRedisFlag } from "./flag.js";
import { CachedRedisNumber } from "./cachedValue.js";
import { MetricsStreamConsumer } from "./consumer.js";
import { MetricsStreamEmitter } from "./emitter.js";
import { shardFor } from "./hash.js";
import { streamKey, type MetricDefinition } from "./types.js";

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

function definitionFor(suffix: string, shardCount = 2): MetricDefinition {
  return { name: `qm_${Date.now()}_${suffix}`, shardCount, consumerGroup: "cg", maxLen: 1000 };
}

redisTest(
  "emitter -> consumer round trip maps rows, dedups, and acks",
  async ({ redisOptions }) => {
    const definition = definitionFor("rt");
    const emitter = new MetricsStreamEmitter({
      redis: redisOptions,
      definition,
      flag: { enabled: () => true },
    });
    const inserted: Array<{ rows: Array<Record<string, string>>; dedupToken: string }> = [];

    const consumer = new MetricsStreamConsumer<Record<string, string>>({
      redis: redisOptions,
      definition,
      consumerName: "c1",
      mapEntry: (e) => ({ id: e.id, ...e.fields }),
      insert: async (rows, { dedupToken }) => {
        inserted.push({ rows, dedupToken });
      },
      blockMs: 200,
    });

    await consumer.start();
    await emitter.waitUntilReady();
    emitter.emit("queueA", { op: "enqueue", q: "queueA" });
    emitter.emit("queueB", { op: "started", q: "queueB", wait: 42 });

    await waitFor(() => inserted.flatMap((i) => i.rows).length >= 2);
    await consumer.stop();

    const rows = inserted.flatMap((i) => i.rows);
    expect(rows).toContainEqual(expect.objectContaining({ op: "enqueue", q: "queueA" }));
    expect(rows).toContainEqual(
      expect.objectContaining({ op: "started", q: "queueB", wait: "42" })
    );
    expect(inserted[0]!.dedupToken).toMatch(/^[0-9a-f]{40}$/);

    const admin = createRedisClient({ ...redisOptions, keyPrefix: undefined });
    for (const key of consumer.streamKeys()) {
      const pending = (await admin.xpending(key, definition.consumerGroup)) as [
        number,
        ...unknown[],
      ];
      expect(pending[0]).toBe(0);
    }
    await admin.quit();
    await emitter.close();
  }
);

redisTest("emit is a no-op when the flag is disabled", async ({ redisOptions }) => {
  const definition = definitionFor("off");
  const emitter = new MetricsStreamEmitter({
    redis: redisOptions,
    definition,
    flag: { enabled: () => false },
  });

  emitter.emit("q", { op: "enqueue", q: "q" });
  await new Promise((r) => setTimeout(r, 200));

  const admin = createRedisClient({ ...redisOptions, keyPrefix: undefined });
  const len = await admin.xlen(streamKey(definition, shardFor("q", definition.shardCount)));
  expect(len).toBe(0);
  await admin.quit();
  await emitter.close();
});

redisTest("reclaims stale pending entries from a dead consumer", async ({ redisOptions }) => {
  const definition = definitionFor("claim", 1);
  const admin = createRedisClient({ ...redisOptions, keyPrefix: undefined });
  const key = streamKey(definition, 0);

  await admin.xgroup("CREATE", key, definition.consumerGroup, "$", "MKSTREAM");
  await admin.xadd(key, "*", "op", "ack", "q", "qZ");
  await admin.xadd(key, "*", "op", "nack", "q", "qZ");
  await admin.xreadgroup(
    "GROUP",
    definition.consumerGroup,
    "zombie",
    "COUNT",
    10,
    "STREAMS",
    key,
    ">"
  );

  const inserted: Array<Record<string, string>> = [];
  const consumer = new MetricsStreamConsumer<Record<string, string>>({
    redis: redisOptions,
    definition,
    consumerName: "live",
    mapEntry: (e) => ({ id: e.id, ...e.fields }),
    insert: async (rows) => {
      inserted.push(...rows);
    },
    blockMs: 200,
    claimIdleMs: 0,
  });

  await consumer.start();
  await waitFor(() => inserted.length >= 2);
  await consumer.stop();

  expect(inserted.map((r) => r.op).sort()).toEqual(["ack", "nack"]);
  const pending = (await admin.xpending(key, definition.consumerGroup)) as [number, ...unknown[]];
  expect(pending[0]).toBe(0);
  await admin.quit();
});

redisTest(
  "per-stream batches: one insert + distinct dedup token per shard stream",
  async ({ redisOptions }) => {
    const definition = definitionFor("pershard", 2);
    const emitter = new MetricsStreamEmitter({
      redis: redisOptions,
      definition,
      flag: { enabled: () => true },
    });
    // Two shard keys that land on different shards.
    const a = "shardkey-a";
    let b = "shardkey-b0";
    for (let i = 1; shardFor(b, 2) === shardFor(a, 2); i++) b = `shardkey-b${i}`;

    const inserted: Array<{ rows: Array<Record<string, string>>; dedupToken: string }> = [];
    const consumer = new MetricsStreamConsumer<Record<string, string>>({
      redis: redisOptions,
      definition,
      consumerName: "c1",
      mapEntry: (e) => ({ id: e.id, ...e.fields }),
      insert: async (rows, { dedupToken }) => {
        inserted.push({ rows, dedupToken });
      },
      blockMs: 200,
    });

    await consumer.start();
    await emitter.waitUntilReady();
    emitter.emit(a, { op: "enqueue", q: a });
    emitter.emit(b, { op: "enqueue", q: b });
    await waitFor(() => inserted.flatMap((i) => i.rows).length >= 2);
    await consumer.stop();
    await emitter.close();

    // Each shard's batch is its own dedup block with its own (stream-scoped) token.
    const batchesWithRows = inserted.filter((i) => i.rows.length > 0);
    expect(batchesWithRows.length).toBe(2);
    expect(new Set(batchesWithRows.map((i) => i.dedupToken)).size).toBe(2);
  }
);

redisTest(
  "probe reports lag as null (not 0) when Redis cannot compute it",
  async ({ redisOptions }) => {
    const definition = definitionFor("nillag", 1);
    const admin = createRedisClient({ ...redisOptions, keyPrefix: undefined });
    const key = streamKey(definition, 0);

    await admin.xgroup("CREATE", key, definition.consumerGroup, "0", "MKSTREAM");
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push((await admin.xadd(key, "*", "op", "enqueue", "q", "qT")) as string);
    }
    // SETID to an arbitrary id makes the group's entries-read unknown => lag is nil
    // (severe trimming can do the same in prod); the probe must NOT report that as 0.
    await admin.xgroup("SETID", key, definition.consumerGroup, ids[2]!);

    const consumer = new MetricsStreamConsumer<Record<string, string>>({
      redis: redisOptions,
      definition,
      consumerName: "c1",
      mapEntry: (e) => ({ id: e.id, ...e.fields }),
      insert: async () => {},
    });
    try {
      const states = await consumer.streamState();
      expect(states[0]!.lag).toBeNull();
    } finally {
      await consumer.stop();
      await admin.quit();
    }
  }
);

redisTest(
  "emitGauge XADDs an op=gauge snapshot onto the shared metrics stream",
  async ({ redisOptions }) => {
    const definition = definitionFor("gauge", 2);
    const emitter = new MetricsStreamEmitter({
      redis: redisOptions,
      definition,
      flag: { enabled: () => true },
    });

    // Emits before the connection is ready are dropped by design (loss-tolerant).
    await emitter.waitUntilReady();
    emitter.emitGauge("q1", {
      op: "gauge",
      q: "q1",
      ql: 5,
      cc: 2,
      lim: 10,
      eql: 3,
      ec: 1,
      elim: 20,
      thr: 0,
    });

    const admin = createRedisClient({ ...redisOptions, keyPrefix: undefined });
    const key = streamKey(definition, shardFor("q1", 2));
    // Plain XADD (no odometer, no cum=0 seed) => exactly one entry, unlike counter emit().
    await waitFor2(async () => (await admin.xlen(key)) === 1);
    const raw = (await admin.xrange(key, "-", "+")) as Array<[string, string[]]>;
    const flat = raw[0]![1];
    const fields: Record<string, string> = {};
    for (let i = 0; i + 1 < flat.length; i += 2) fields[flat[i]!] = flat[i + 1]!;
    expect(fields.op).toBe("gauge");
    expect(fields.q).toBe("q1");
    expect(fields.ql).toBe("5");
    expect(fields.thr).toBe("0");
    await admin.quit();
    await emitter.close();
  }
);

async function waitFor2(cond: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor2 timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

redisTest("sampledSync gates on both the flag and the sample rate", async ({ redisOptions }) => {
  const definition = definitionFor("sample");
  const off = new MetricsStreamEmitter({
    redis: redisOptions,
    definition,
    flag: { enabled: () => true },
    gaugeSampleRate: 0,
  });
  const on = new MetricsStreamEmitter({
    redis: redisOptions,
    definition,
    flag: { enabled: () => true },
    gaugeSampleRate: 1,
  });
  const disabled = new MetricsStreamEmitter({
    redis: redisOptions,
    definition,
    flag: { enabled: () => false },
    gaugeSampleRate: 1,
  });

  expect(off.sampledSync()).toBe(false); // rate 0 => never sampled in
  expect(on.sampledSync()).toBe(true); // rate 1 + enabled => always
  expect(disabled.sampledSync()).toBe(false); // disabled => never, regardless of rate
  expect(on.enabledSync()).toBe(true); // enabledSync (counters) is unaffected by sampling

  await Promise.all([off.close(), on.close(), disabled.close()]);
});

redisTest("sampledSync honors a live rate provider (no reconstruct)", async ({ redisOptions }) => {
  const definition = definitionFor("live");
  let rate = 1;
  const emitter = new MetricsStreamEmitter({
    redis: redisOptions,
    definition,
    flag: { enabled: () => true },
    gaugeSampleRate: { value: () => rate },
  });
  expect(emitter.sampledSync()).toBe(true);
  rate = 0;
  expect(emitter.sampledSync()).toBe(false);
  await emitter.close();
});

redisTest("CachedRedisNumber reads live, clamps, and falls back", async ({ redisOptions }) => {
  const key = `rate_${Date.now()}`;
  const admin = createRedisClient({ ...redisOptions, keyPrefix: undefined });
  const num = new CachedRedisNumber({ redis: redisOptions, key, defaultValue: 1, min: 0, max: 1 });

  await num.refresh();
  expect(num.value()).toBe(1); // missing key => default
  await admin.set(key, "0.25");
  await num.refresh();
  expect(num.value()).toBe(0.25);
  await admin.set(key, "5");
  await num.refresh();
  expect(num.value()).toBe(1); // out of range => clamped
  await admin.set(key, "nonsense");
  await num.refresh();
  expect(num.value()).toBe(1); // unparseable => default

  await num.close();
  await admin.quit();
});

redisTest("streamState reports depth, lag, and pending per shard", async ({ redisOptions }) => {
  const definition = definitionFor("state", 1);
  const admin = createRedisClient({ ...redisOptions, keyPrefix: undefined });
  const key = streamKey(definition, 0);

  await admin.xgroup("CREATE", key, definition.consumerGroup, "$", "MKSTREAM");
  await admin.xadd(key, "*", "op", "enqueue", "q", "qX");
  await admin.xadd(key, "*", "op", "ack", "q", "qX");
  // Read one entry as some consumer and leave it unacked -> 1 pending, 1 still undelivered.
  await admin.xreadgroup(
    "GROUP",
    definition.consumerGroup,
    "reader",
    "COUNT",
    1,
    "STREAMS",
    key,
    ">"
  );

  const consumer = new MetricsStreamConsumer<Record<string, string>>({
    redis: redisOptions,
    definition,
    consumerName: "c1",
    mapEntry: (e) => ({ id: e.id, ...e.fields }),
    insert: async () => {},
  });

  try {
    const states = await consumer.streamState();
    expect(states).toHaveLength(1);
    expect(states[0]!.depth).toBe(2);
    expect(states[0]!.pending).toBe(1);
    expect(states[0]!.lag).toBe(1);
  } finally {
    await consumer.stop();
    await admin.quit();
  }
});

redisTest("CachedRedisFlag reads a redis key with caching", async ({ redisOptions }) => {
  const key = `flag_${Date.now()}`;
  const admin = createRedisClient({ ...redisOptions, keyPrefix: undefined });
  const flag = new CachedRedisFlag({ redis: redisOptions, key, cacheTtlMs: 10_000 });

  expect(flag.enabled()).toBe(false);
  await flag.refresh();
  expect(flag.enabled()).toBe(false);

  await admin.set(key, "1");
  await flag.refresh();
  expect(flag.enabled()).toBe(true);

  await admin.set(key, "0");
  await flag.refresh();
  expect(flag.enabled()).toBe(false);

  await flag.close();
  await admin.quit();
});

redisTest("CachedRedisFlag warms eagerly on construction", async ({ redisOptions }) => {
  const key = `flag_eager_${Date.now()}`;
  const admin = createRedisClient({ ...redisOptions, keyPrefix: undefined });
  await admin.set(key, "1");

  const flag = new CachedRedisFlag({ redis: redisOptions, key });
  // No manual refresh(): the constructor kicks one off so the first real read is warm.
  await waitFor(() => flag.enabled() === true);
  expect(flag.enabled()).toBe(true);

  await flag.close();
  await admin.quit();
});
