import type { MetricsV1Input } from "@internal/clickhouse";
import { describe, expect, it, vi } from "vitest";
import {
  API_RATE_LIMIT_METRIC_NAMES,
  ApiRateLimitMetricsAggregator,
  rateLimitConfigToLimits,
  type ApiRateLimitMetricsAggregatorOptions,
} from "~/services/apiRateLimitMetricsAggregator.server";
import type {
  RateLimiterConfig,
  RateLimitObservation,
} from "~/services/authorizationRateLimitMiddleware.server";

const tenant = {
  organizationId: "org_1",
  projectId: "proj_1",
  environmentId: "env_1",
  metricsEnabled: true,
};

const tokenBucket: RateLimiterConfig = {
  type: "tokenBucket",
  refillRate: 250,
  interval: "10s",
  maxTokens: 750,
};

const T0 = Date.UTC(2026, 0, 15, 9, 30, 4, 250);

function observation(overrides: Partial<RateLimitObservation> = {}): RateLimitObservation {
  return {
    identifier: "env_1",
    tenant,
    config: tokenBucket,
    success: true,
    limit: 100,
    remaining: 42,
    reset: T0 + 60_000,
    ...overrides,
  };
}

function build(overrides: Partial<ApiRateLimitMetricsAggregatorOptions> = {}) {
  const sink = vi.fn<(rows: MetricsV1Input[]) => void>();
  const onDropped = vi.fn<(count: number) => void>();
  let now = T0;
  const aggregator = new ApiRateLimitMetricsAggregator({
    bucketSeconds: 10,
    maxEntries: 1000,
    isEnabled: () => true,
    sink,
    onDropped,
    now: () => now,
    ...overrides,
  });
  return { aggregator, sink, onDropped, setNow: (ms: number) => (now = ms) };
}

function rowsByName(rows: MetricsV1Input[]) {
  return Object.fromEntries(rows.map((row) => [row.metric_name, row]));
}

describe("ApiRateLimitMetricsAggregator", () => {
  it("floors observations into bucketSeconds-wide buckets keyed per environment", () => {
    const { aggregator, sink, setNow } = build();

    aggregator.record(observation());
    setNow(T0 + 3_000);
    aggregator.record(observation());
    expect(aggregator.size).toBe(1);

    setNow(Date.UTC(2026, 0, 15, 9, 30, 10, 0));
    aggregator.record(observation());
    expect(aggregator.size).toBe(2);

    aggregator.record(observation({ tenant: { ...tenant, environmentId: "env_2" } }));
    expect(aggregator.size).toBe(3);

    aggregator.flush();
    const buckets = new Set(sink.mock.calls[0]![0].map((row) => row.bucket_start));
    expect(buckets).toEqual(new Set(["2026-01-15 09:30:00", "2026-01-15 09:30:10"]));
  });

  it("counts allowed and denied separately and tracks the minimum remaining", () => {
    const { aggregator, sink } = build();

    aggregator.record(observation({ success: true, remaining: 40 }));
    aggregator.record(observation({ success: true, remaining: 39 }));
    aggregator.record(observation({ success: false, remaining: 0 }));
    aggregator.record(observation({ success: true, remaining: 50 }));

    expect(aggregator.flush()).toBe(5);
    const rows = rowsByName(sink.mock.calls[0]![0]);
    expect(rows[API_RATE_LIMIT_METRIC_NAMES.allowed]!.value).toBe(3);
    expect(rows[API_RATE_LIMIT_METRIC_NAMES.denied]!.value).toBe(1);
    expect(rows[API_RATE_LIMIT_METRIC_NAMES.remainingMin]!.value).toBe(0);
  });

  it("clamps negative remaining to 0 before taking the minimum", () => {
    const { aggregator, sink } = build();

    aggregator.record(observation({ success: false, remaining: -3 }));
    aggregator.record(observation({ success: true, remaining: 7 }));

    aggregator.flush();
    const rows = rowsByName(sink.mock.calls[0]![0]);
    expect(rows[API_RATE_LIMIT_METRIC_NAMES.remainingMin]!.value).toBe(0);
  });

  it("ignores observations without a tenant", () => {
    const { aggregator, sink } = build();

    aggregator.record(observation({ tenant: undefined }));

    expect(aggregator.size).toBe(0);
    expect(aggregator.flush()).toBe(0);
    expect(sink).not.toHaveBeenCalled();
  });

  it("records nothing while isEnabled() is false", () => {
    let enabled = false;
    const { aggregator } = build({ isEnabled: () => enabled });

    aggregator.record(observation());
    expect(aggregator.size).toBe(0);

    enabled = true;
    aggregator.record(observation());
    expect(aggregator.size).toBe(1);
  });

  it("never grows past maxEntries and reports each dropped observation", () => {
    const { aggregator, onDropped } = build({ maxEntries: 2 });

    aggregator.record(observation({ tenant: { ...tenant, environmentId: "env_a" } }));
    aggregator.record(observation({ tenant: { ...tenant, environmentId: "env_b" } }));
    aggregator.record(observation({ tenant: { ...tenant, environmentId: "env_c" } }));
    aggregator.record(observation({ tenant: { ...tenant, environmentId: "env_d" } }));

    expect(aggregator.size).toBe(2);
    expect(onDropped).toHaveBeenCalledTimes(2);
    expect(onDropped).toHaveBeenCalledWith(1);

    aggregator.record(observation({ tenant: { ...tenant, environmentId: "env_a" } }));
    expect(aggregator.size).toBe(2);
    expect(onDropped).toHaveBeenCalledTimes(2);
  });

  it("discard() drops everything held and reports the folded observation count", () => {
    const { aggregator, sink } = build();

    aggregator.record(observation());
    aggregator.record(observation({ success: false, remaining: -1 }));
    aggregator.record(observation({ tenant: { ...tenant, environmentId: "env_2" } }));
    expect(aggregator.size).toBe(2);

    expect(aggregator.discard()).toBe(3);
    expect(aggregator.size).toBe(0);
    expect(aggregator.discard()).toBe(0);
    expect(aggregator.flush()).toBe(0);
    expect(sink).not.toHaveBeenCalled();
  });

  it("admits a previously dropped environment once a flush frees the cap", () => {
    const { aggregator, sink, onDropped } = build({ maxEntries: 1 });

    aggregator.record(observation({ tenant: { ...tenant, environmentId: "env_a" } }));
    aggregator.record(observation({ tenant: { ...tenant, environmentId: "env_b" } }));
    expect(onDropped).toHaveBeenCalledTimes(1);

    expect(aggregator.flush()).toBeGreaterThan(0);
    expect(aggregator.size).toBe(0);

    aggregator.record(observation({ tenant: { ...tenant, environmentId: "env_b" } }));
    expect(aggregator.size).toBe(1);
    expect(onDropped).toHaveBeenCalledTimes(1);

    aggregator.flush();
    const flushed = sink.mock.calls.flatMap(([rows]) => rows);
    expect(flushed.map((row) => row.environment_id)).toEqual(
      expect.arrayContaining(["env_a", "env_b"])
    );
  });

  it("flushes delta rows in the metrics_v1 shape and clears its state", () => {
    const { aggregator, sink } = build();

    aggregator.record(observation({ success: true, remaining: 99 }));
    aggregator.record(observation({ success: false, remaining: -1 }));

    expect(aggregator.flush()).toBe(5);
    expect(sink).toHaveBeenCalledTimes(1);

    const rows = sink.mock.calls[0]![0];
    expect(rows).toHaveLength(5);
    expect(rows).toEqual(
      expect.arrayContaining([
        {
          organization_id: "org_1",
          project_id: "proj_1",
          environment_id: "env_1",
          metric_name: "api.rate_limit.allowed",
          metric_type: "sum",
          metric_subject: "",
          bucket_start: "2026-01-15 09:30:00",
          value: 1,
          attributes: {},
        },
        {
          organization_id: "org_1",
          project_id: "proj_1",
          environment_id: "env_1",
          metric_name: "api.rate_limit.denied",
          metric_type: "sum",
          metric_subject: "",
          bucket_start: "2026-01-15 09:30:00",
          value: 1,
          attributes: {},
        },
        {
          organization_id: "org_1",
          project_id: "proj_1",
          environment_id: "env_1",
          metric_name: "api.rate_limit.remaining_min",
          metric_type: "gauge",
          metric_subject: "",
          bucket_start: "2026-01-15 09:30:00",
          value: 0,
          attributes: {},
        },
        {
          organization_id: "org_1",
          project_id: "proj_1",
          environment_id: "env_1",
          metric_name: "api.rate_limit.limit.per_second",
          metric_type: "gauge",
          metric_subject: "",
          bucket_start: "2026-01-15 09:30:00",
          value: 25,
          attributes: {},
        },
        {
          organization_id: "org_1",
          project_id: "proj_1",
          environment_id: "env_1",
          metric_name: "api.rate_limit.limit.burst",
          metric_type: "gauge",
          metric_subject: "",
          bucket_start: "2026-01-15 09:30:00",
          value: 750,
          attributes: {},
        },
      ])
    );

    expect(aggregator.size).toBe(0);
    expect(aggregator.flush()).toBe(0);
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it("omits zero-count allowed and denied rows but always emits the gauges", () => {
    const { aggregator, sink } = build();

    aggregator.record(observation({ success: true, remaining: 10 }));

    expect(aggregator.flush()).toBe(4);
    const names = sink.mock.calls[0]![0].map((row) => row.metric_name).sort();
    expect(names).toEqual([
      "api.rate_limit.allowed",
      "api.rate_limit.limit.burst",
      "api.rate_limit.limit.per_second",
      "api.rate_limit.remaining_min",
    ]);
  });

  it("skips the limit gauges when the config window cannot be parsed", () => {
    const { aggregator, sink } = build();

    aggregator.record(
      observation({ config: { type: "fixedWindow", window: "soon" as never, tokens: 10 } })
    );

    expect(aggregator.flush()).toBe(2);
    const names = sink.mock.calls[0]![0].map((row) => row.metric_name).sort();
    expect(names).toEqual(["api.rate_limit.allowed", "api.rate_limit.remaining_min"]);
  });

  it("drops the batch and logs when an async sink rejects", async () => {
    const { aggregator } = build({
      sink: () => Promise.reject(new Error("clickhouse is down")),
    });

    aggregator.record(observation());

    expect(aggregator.flush()).toBe(4);
    expect(aggregator.size).toBe(0);
    await new Promise((resolve) => setImmediate(resolve));
  });

  it("swallows a throwing sink and still clears the drained entries", () => {
    const { aggregator } = build({
      sink: () => {
        throw new Error("clickhouse is down");
      },
    });

    aggregator.record(observation());

    expect(() => aggregator.flush()).not.toThrow();
    expect(aggregator.size).toBe(0);
  });

  it("uses bucketSeconds for the bucket width", () => {
    const { aggregator, sink } = build({ bucketSeconds: 60 });

    aggregator.record(observation());
    aggregator.flush();

    expect(sink.mock.calls[0]![0][0]!.bucket_start).toBe("2026-01-15 09:30:00");
  });
});

describe("rateLimitConfigToLimits", () => {
  it("normalises a token bucket to tokens per second plus its burst ceiling", () => {
    expect(rateLimitConfigToLimits(tokenBucket)).toEqual({ perSecond: 25, burst: 750 });
    expect(
      rateLimitConfigToLimits({
        type: "tokenBucket",
        refillRate: 60,
        interval: "1m",
        maxTokens: 90,
      })
    ).toEqual({ perSecond: 1, burst: 90 });
  });

  it("treats a fixed or sliding window as tokens over the window", () => {
    expect(rateLimitConfigToLimits({ type: "fixedWindow", window: "1m", tokens: 60 })).toEqual({
      perSecond: 1,
      burst: 60,
    });
    expect(
      rateLimitConfigToLimits({ type: "slidingWindow", window: "500ms", tokens: 100 })
    ).toEqual({ perSecond: 200, burst: 100 });
  });

  it("returns undefined for a window it cannot parse", () => {
    expect(
      rateLimitConfigToLimits({ type: "fixedWindow", window: "eventually" as never, tokens: 60 })
    ).toBeUndefined();
    expect(
      rateLimitConfigToLimits({ type: "fixedWindow", window: "0s" as never, tokens: 60 })
    ).toBeUndefined();
  });
});
