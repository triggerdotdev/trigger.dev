import { describe, expect, it } from "vitest";
import {
  descriptorFromQueue,
  mapEntryToRow,
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
    });
  });

  it("strips a concurrency-key suffix", () => {
    expect(descriptorFromQueue("{org:o1}:proj:p1:env:e1:queue:task/t:ck:tenant-3")).toEqual(
      expect.objectContaining({ queue_name: "task/t" })
    );
  });

  it("keeps colons inside the queue name", () => {
    expect(descriptorFromQueue("{org:o1}:proj:p1:env:e1:queue:my:odd:queue")).toEqual(
      expect.objectContaining({ queue_name: "my:odd:queue" })
    );
  });

  it("keeps colons in the name while stripping a real ck suffix", () => {
    expect(descriptorFromQueue("{org:o1}:proj:p1:env:e1:queue:a:b:ck:t9")).toEqual(
      expect.objectContaining({ queue_name: "a:b" })
    );
  });

  it("rejects malformed descriptors", () => {
    expect(descriptorFromQueue("not-a-descriptor")).toBeNull();
    expect(descriptorFromQueue("{org:o1}:proj:p1:env:e1")).toBeNull();
    expect(descriptorFromQueue("")).toBeNull();
  });
});

describe("QueueNameLimiter", () => {
  it("passes names through under the cap and overflows past it, per env", () => {
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

  it("evicts the oldest env when the env map is full", () => {
    const limiter = new QueueNameLimiter(1, 2);
    expect(limiter.limit("env1", "a")).toBe("a");
    expect(limiter.limit("env2", "a")).toBe("a");
    expect(limiter.limit("env3", "a")).toBe("a");
    expect(limiter.limit("env1", "b")).toBe("b");
  });
});

describe("mapEntryToRow", () => {
  const q = "{org:o1}:proj:p1:env:e1:queue:task/t";

  it("maps a gauge entry with numeric fields", () => {
    const row = mapEntryToRow({
      id: "1700000000000-0",
      fields: { op: "gauge", q, ql: "5", cc: "2", lim: "10", eql: "7", ec: "3", elim: "20", thr: "1" },
    });
    expect(row).toEqual(
      expect.objectContaining({
        op: "gauge",
        organization_id: "o1",
        queue_name: "task/t",
        queued: 5,
        running: 2,
        queue_limit: 10,
        env_queued: 7,
        env_running: 3,
        env_limit: 20,
        throttled: 1,
      })
    );
    expect(row!.event_time).toBe("2023-11-14 22:13:20");
  });

  it("maps started with wait_ms + cumulative and drops unknown ops", () => {
    const started = mapEntryToRow({
      id: "1700000000000-0",
      fields: { op: "started", q, wait: "48", cum: "512" },
    });
    expect(started).toEqual(
      expect.objectContaining({
        op: "started",
        wait_ms: 48,
        cumulative: 512,
        order_key: 1700000000000 * 100000,
      })
    );
    expect(mapEntryToRow({ id: "1-0", fields: { op: "ack", q, cum: "9" } })).toEqual(
      expect.objectContaining({ op: "ack", cumulative: 9 })
    );
    expect(mapEntryToRow({ id: "1-0", fields: { op: "bogus", q } })).toBeNull();
    expect(mapEntryToRow({ id: "1-0", fields: { op: "ack" } })).toBeNull();
  });

  it("applies the queue-name limiter", () => {
    const limiter = new QueueNameLimiter(1);
    const first = mapEntryToRow({ id: "1-0", fields: { op: "ack", q } }, limiter);
    expect(first!.queue_name).toBe("task/t");
    const second = mapEntryToRow(
      { id: "1-1", fields: { op: "ack", q: "{org:o1}:proj:p1:env:e1:queue:task/other" } },
      limiter
    );
    expect(second!.queue_name).toBe(OVERFLOW_QUEUE_NAME);
  });
});
