import { describe, expect, it } from "vitest";
import {
  descriptorFromQueue,
  mapEntryToRows,
  OVERFLOW_QUEUE_NAME,
  QueueNameLimiter,
} from "~/v3/queueMetricsMapping";

describe("descriptorFromQueue", () => {
  it("parses a plain descriptor", () => {
    expect(descriptorFromQueue("{org:o1}:proj:p1:env:e1:queue:task/my-task")).toEqual({
      organization_id: "o1",
      project_id: "p1",
      environment_id: "e1",
      queue_name: "task/my-task",
      concurrency_key: "",
    });
  });

  it("captures a concurrency-key suffix", () => {
    expect(descriptorFromQueue("{org:o1}:proj:p1:env:e1:queue:task/t:ck:tenant-3")).toEqual(
      expect.objectContaining({ queue_name: "task/t", concurrency_key: "tenant-3" })
    );
  });

  it("maps the ck wildcard to no key", () => {
    expect(descriptorFromQueue("{org:o1}:proj:p1:env:e1:queue:task/t:ck:*")).toEqual(
      expect.objectContaining({ queue_name: "task/t", concurrency_key: "" })
    );
  });

  it("keeps colons inside the queue name", () => {
    expect(descriptorFromQueue("{org:o1}:proj:p1:env:e1:queue:my:odd:queue")).toEqual(
      expect.objectContaining({ queue_name: "my:odd:queue", concurrency_key: "" })
    );
  });

  it("keeps colons in the name while capturing a real ck suffix", () => {
    expect(descriptorFromQueue("{org:o1}:proj:p1:env:e1:queue:a:b:ck:t9")).toEqual(
      expect.objectContaining({ queue_name: "a:b", concurrency_key: "t9" })
    );
  });

  it("rejects malformed descriptors", () => {
    expect(descriptorFromQueue("not-a-descriptor")).toBeNull();
    expect(descriptorFromQueue("{org:o1}:proj:p1:env:e1")).toBeNull();
    expect(descriptorFromQueue("")).toBeNull();
  });
});

describe("QueueNameLimiter", () => {
  it("passes names through under the cap and overflows past it, per scope", () => {
    const limiter = new QueueNameLimiter(2);
    expect(limiter.limit("env1", "a")).toBe("a");
    expect(limiter.limit("env1", "b")).toBe("b");
    expect(limiter.limit("env1", "c")).toBe(OVERFLOW_QUEUE_NAME);
    expect(limiter.limit("env1", "a")).toBe("a");
    expect(limiter.limit("env2", "c")).toBe("c");
  });

  it("is unlimited when the cap is 0", () => {
    const limiter = new QueueNameLimiter(0);
    for (let i = 0; i < 100; i++) {
      expect(limiter.limit("env1", `q${i}`)).toBe(`q${i}`);
    }
  });

  it("evicts the oldest scope when the scope map is full", () => {
    const limiter = new QueueNameLimiter(1, 2);
    expect(limiter.limit("env1", "a")).toBe("a");
    expect(limiter.limit("env2", "a")).toBe("a");
    expect(limiter.limit("env3", "a")).toBe("a");
    expect(limiter.limit("env1", "b")).toBe("b");
  });
});

describe("mapEntryToRows", () => {
  const q = "{org:o1}:proj:p1:env:e1:queue:task/t";

  it("maps a gauge entry with numeric fields", () => {
    const rows = mapEntryToRows({
      id: "1700000000000-0",
      fields: {
        op: "gauge",
        q,
        ql: "5",
        cc: "2",
        lim: "10",
        eql: "7",
        ec: "3",
        elim: "20",
        thr: "1",
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        op: "gauge",
        organization_id: "o1",
        queue_name: "task/t",
        concurrency_key: "",
        queued: 5,
        running: 2,
        queue_limit: 10,
        env_queued: 7,
        env_running: 3,
        env_limit: 20,
        throttled: 1,
      })
    );
    expect(rows[0]!.event_time).toBe("2023-11-14 22:13:20");
    expect(rows[0]!.ck_backlogged).toBeUndefined();
    expect(rows[0]!.ck_max_wait_ms).toBeUndefined();
  });

  it("keeps the key on per-subqueue gauges and maps the CK-health tail", () => {
    const rows = mapEntryToRows({
      id: "1700000000000-0",
      fields: { op: "gauge", q: `${q}:ck:tenant-1`, ql: "4", ckq: "3", ckw: "2500" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        op: "gauge",
        queue_name: "task/t",
        concurrency_key: "tenant-1",
        queued: 4,
        ck_backlogged: 3,
        ck_max_wait_ms: 2500,
      })
    );
  });

  it("maps started with wait_ms + cumulative and drops unknown ops", () => {
    const started = mapEntryToRows({
      id: "1700000000000-0",
      fields: { op: "started", q, wait: "48", cum: "512" },
    });
    expect(started).toHaveLength(1);
    expect(started[0]).toEqual(
      expect.objectContaining({
        op: "started",
        wait_ms: 48,
        cumulative: 512,
        order_key: (1700000000000n * 1000000n).toString(),
      })
    );
    expect(mapEntryToRows({ id: "1-0", fields: { op: "ack", q, cum: "9" } })[0]).toEqual(
      expect.objectContaining({ op: "ack", cumulative: 9 })
    );
    expect(mapEntryToRows({ id: "1-0", fields: { op: "bogus", q } })).toEqual([]);
    expect(mapEntryToRows({ id: "1-0", fields: { op: "ack" } })).toEqual([]);
  });

  it("expands a dual-odometer counter entry into base + per-key rows", () => {
    const rows = mapEntryToRows({
      id: "1700000000000-3",
      fields: { op: "started", q, ck: "tenant-9", wait: "80", cum: "41", ckcum: "7" },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(
      expect.objectContaining({ queue_name: "task/t", cumulative: 41, wait_ms: 80 })
    );
    expect(rows[0]!.concurrency_key).toBeUndefined();
    expect(rows[1]).toEqual(
      expect.objectContaining({
        queue_name: "task/t",
        concurrency_key: "tenant-9",
        cumulative: 7,
        wait_ms: 80,
      })
    );
    expect(rows[0]!.order_key).toBe(rows[1]!.order_key);

    // Baseline entries carry exactly one odometer each.
    const baseBaseline = mapEntryToRows({ id: "1-0", fields: { op: "started", q, cum: "0" } });
    expect(baseBaseline).toHaveLength(1);
    expect(baseBaseline[0]!.concurrency_key).toBeUndefined();
    const ckBaseline = mapEntryToRows({
      id: "1-1",
      fields: { op: "started", q, ck: "tenant-9", ckcum: "0" },
    });
    expect(ckBaseline).toHaveLength(1);
    expect(ckBaseline[0]).toEqual(
      expect.objectContaining({ concurrency_key: "tenant-9", cumulative: 0 })
    );
  });

  it("applies the queue-name limiter: gauges overflow, counters drop", () => {
    const limiters = { queueNames: new QueueNameLimiter(1) };
    const first = mapEntryToRows({ id: "1-0", fields: { op: "ack", q, cum: "1" } }, limiters);
    expect(first[0]!.queue_name).toBe("task/t");

    // Overflowed gauges keep flowing under the shared name (max stays meaningful),
    // with per-key attribution stripped.
    const overflowGauge = mapEntryToRows(
      {
        id: "1-1",
        fields: { op: "gauge", q: "{org:o1}:proj:p1:env:e1:queue:task/other:ck:t1", ql: "3" },
      },
      limiters
    );
    expect(overflowGauge[0]!.queue_name).toBe(OVERFLOW_QUEUE_NAME);
    expect(overflowGauge[0]!.concurrency_key).toBe("");

    // Overflowed counters are dropped: merging distinct odometers under one key
    // produces garbage deltas.
    const overflowCounter = mapEntryToRows(
      { id: "1-2", fields: { op: "ack", q: "{org:o1}:proj:p1:env:e1:queue:task/other", cum: "4" } },
      limiters
    );
    expect(overflowCounter).toEqual([]);
  });

  it("applies the concurrency-key limiter: overflow drops the per-key row, keeps base", () => {
    const limiters = { concurrencyKeys: new QueueNameLimiter(1) };
    const first = mapEntryToRows(
      { id: "1-0", fields: { op: "ack", q, ck: "t1", cum: "5", ckcum: "2" } },
      limiters
    );
    expect(first).toHaveLength(2);

    const overflowed = mapEntryToRows(
      { id: "1-1", fields: { op: "ack", q, ck: "t2", cum: "6", ckcum: "1" } },
      limiters
    );
    expect(overflowed).toHaveLength(1);
    expect(overflowed[0]!.cumulative).toBe(6);
    expect(overflowed[0]!.concurrency_key).toBeUndefined();

    // Gauge for an overflowed key keeps the row but loses the attribution.
    const overflowGauge = mapEntryToRows(
      { id: "1-2", fields: { op: "gauge", q: `${q}:ck:t3`, ql: "2" } },
      limiters
    );
    expect(overflowGauge).toHaveLength(1);
    expect(overflowGauge[0]!.concurrency_key).toBe("");
  });
});
