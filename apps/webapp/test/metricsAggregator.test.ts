import type { MetricsV1Input } from "@internal/clickhouse";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyUpdate,
  bucketStart,
  cellKey,
  createMetricsAggregator,
  type MetricsAggregatorOptions,
  type MetricsCell,
  type MetricsTenant,
  type MetricUpdate,
  toRows,
} from "~/services/metricsAggregator.server";
import { logger } from "~/services/logger.server";

const tenant: MetricsTenant = {
  organizationId: "org_1",
  projectId: "proj_1",
  environmentId: "env_1",
};

function build(overrides: Partial<MetricsAggregatorOptions<MetricsTenant>> = {}) {
  const sink = vi.fn<(rows: MetricsV1Input[]) => void>();
  const dropped = vi.fn<(count: number, attributes?: Record<string, string>) => void>();
  const rowsFlushed = vi.fn<(count: number) => void>();
  const aggregator = createMetricsAggregator<MetricsTenant>({
    name: "test metrics",
    bucketSeconds: 10,
    maxEntries: 100,
    isEnabled: () => true,
    sink,
    counters: { dropped: { add: dropped }, rowsFlushed: { add: rowsFlushed } },
    ...overrides,
  });
  return { aggregator, sink, dropped, rowsFlushed };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("metrics aggregator", () => {
  it("folds each reducer into a bucketed row", () => {
    const expected = { sum: 14, max: 9, min: 1, first: 4, last: 1 } as const;
    const bucketStartMs = bucketStart(Date.UTC(2026, 0, 15, 9, 30, 4, 250), 10);
    for (const [reducer, value] of Object.entries(expected)) {
      const cell = [4, 9, 1].reduce<MetricsCell | undefined>(
        (cell, next) =>
          applyUpdate(cell, {
            name: "m",
            reducer: reducer as MetricUpdate["reducer"],
            value: next,
          }),
        undefined
      )!;
      const [row] = toRows([
        {
          ...tenant,
          bucketStartMs,
          observations: 3,
          subjects: new Set(),
          cells: new Map([["m", cell]]),
        },
      ]);
      expect([reducer, row!.value, row!.metric_type, row!.bucket_start]).toEqual([
        reducer,
        value,
        reducer === "sum" ? "sum" : "gauge",
        "2026-01-15 09:30:00",
      ]);
    }
  });

  it("keeps a separate row per attribute set, whatever the key order", () => {
    const { aggregator, sink, rowsFlushed } = build();
    expect(cellKey({ name: "c", reducer: "sum", value: 1, attributes: { a: 1, b: 2 } })).toBe(
      cellKey({ name: "c", reducer: "sum", value: 1, attributes: { b: 2, a: 1 } })
    );

    aggregator.count(tenant, "c", 1, { attributes: { reason: "a", scope: "x" } });
    aggregator.count(tenant, "c", 2, { attributes: { scope: "x", reason: "a" } });
    aggregator.count(tenant, "c", 5, { attributes: { reason: "b", scope: "x" } });

    expect(aggregator.flush()).toBe(2);
    expect(rowsFlushed).toHaveBeenCalledWith(2);
    expect(sink.mock.calls[0]![0].map((row) => [row.attributes, row.value])).toEqual([
      [{ reason: "a", scope: "x" }, 3],
      [{ reason: "b", scope: "x" }, 5],
    ]);
  });

  it("drops new entries past maxEntries and counts each dropped observation", () => {
    const { aggregator, dropped } = build({ maxEntries: 1 });

    aggregator.count(tenant, "a", 1);
    aggregator.count({ ...tenant, environmentId: "env_2" }, "a", 1);
    aggregator.count({ ...tenant, environmentId: "env_3" }, "a", 1);
    aggregator.count(tenant, "a", 1);

    expect(aggregator.size()).toBe(1);
    expect(dropped).toHaveBeenCalledTimes(2);
    expect(dropped).toHaveBeenCalledWith(1, { reason: "cap" });
  });

  it("leaves no entry when onCreate throws", () => {
    const { aggregator } = build();

    expect(() =>
      aggregator.record(tenant, [], () => {
        throw new Error("bad config");
      })
    ).toThrow("bad config");
    expect(aggregator.size()).toBe(0);
  });

  it("drops the batch and logs when the sink rejects or throws", async () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => {});
    const rejecting = build({ sink: () => Promise.reject(new Error("down")) });
    rejecting.aggregator.count(tenant, "c", 1);
    expect(rejecting.aggregator.flush()).toBe(1);
    await new Promise((resolve) => setImmediate(resolve));

    const throwing = build({
      sink: () => {
        throw new Error("down");
      },
    });
    throwing.aggregator.count(tenant, "c", 1);
    expect(() => throwing.aggregator.flush()).not.toThrow();
    expect(throwing.aggregator.size()).toBe(0);

    expect(error).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith("test metrics: sink failed, dropping batch", {
      rows: 1,
      error: "down",
    });
  });

  it("flushes on the timer once ready and on stop, and discards on stop before ready", async () => {
    vi.useFakeTimers();
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => (resolveReady = resolve));
    const { aggregator, sink } = build({ flushIntervalMs: 1_000, ready });
    aggregator.start();

    aggregator.count(tenant, "c", 1);
    vi.advanceTimersByTime(1_000);
    expect(sink).not.toHaveBeenCalled();

    resolveReady();
    await Promise.resolve();
    vi.advanceTimersByTime(1_000);
    expect(sink).toHaveBeenCalledTimes(1);

    aggregator.count(tenant, "c", 1);
    aggregator.stop();
    expect(sink).toHaveBeenCalledTimes(2);

    aggregator.count(tenant, "c", 1);
    vi.advanceTimersByTime(5_000);
    expect(sink).toHaveBeenCalledTimes(2);

    const never = build({ flushIntervalMs: 1_000, ready: new Promise(() => {}) });
    never.aggregator.start();
    never.aggregator.count(tenant, "c", 1);
    never.aggregator.count(tenant, "c", 1);
    never.aggregator.stop();
    expect(never.sink).not.toHaveBeenCalled();
    expect(never.dropped).toHaveBeenCalledWith(2, { reason: "shutdown_before_ready" });
  });
});
