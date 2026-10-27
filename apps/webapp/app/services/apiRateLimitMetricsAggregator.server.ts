import type {
  RateLimiterConfig,
  RateLimitObservation,
  RateLimitTenant,
} from "./authorizationRateLimitMiddleware.server";
import {
  createMetricsAggregator,
  type MetricsAggregatorOptions,
  type MetricUpdate,
} from "./metricsAggregator.server";
import { parseDuration } from "./realtime/duration.server";

export const API_RATE_LIMIT_METRIC_NAMES = {
  allowed: "api.rate_limit.allowed",
  denied: "api.rate_limit.denied",
  remainingMin: "api.rate_limit.remaining_min",
  limitPerSecond: "api.rate_limit.limit.per_second",
  limitBurst: "api.rate_limit.limit.burst",
} as const;

export type RateLimitLimits = {
  /** Sustained rate the bucket refills at, normalised to tokens per second. */
  perSecond: number;
  /** Most requests the bucket admits at once. */
  burst: number;
};

const MILLISECONDS_PATTERN = /^(\d+)\s*ms$/;

function durationSeconds(duration: string): number | undefined {
  const millis = duration.trim().toLowerCase().match(MILLISECONDS_PATTERN);
  if (millis) {
    return Number(millis[1]) / 1000;
  }
  try {
    return parseDuration(duration);
  } catch {
    return undefined;
  }
}

/**
 * Reduces any limiter config to the two numbers a usage chart needs. Returns undefined when
 * the window cannot be parsed so a malformed override never breaks recording.
 */
export function rateLimitConfigToLimits(config: RateLimiterConfig): RateLimitLimits | undefined {
  const windowSeconds = durationSeconds(
    config.type === "tokenBucket" ? config.interval : config.window
  );
  if (!windowSeconds || windowSeconds <= 0) {
    return undefined;
  }
  if (config.type === "tokenBucket") {
    return { perSecond: config.refillRate / windowSeconds, burst: config.maxTokens };
  }
  return { perSecond: config.tokens / windowSeconds, burst: config.tokens };
}

export type ApiRateLimitMetricsAggregatorOptions = Omit<
  MetricsAggregatorOptions<RateLimitTenant>,
  "name"
>;

/**
 * Counts the API rate limiter's allow/deny decisions per (environment, time bucket) as
 * delta rows, so sum() at read time stays exact across replicas and flushes.
 */
export function createApiRateLimitMetricsAggregator(options: ApiRateLimitMetricsAggregatorOptions) {
  const metrics = createMetricsAggregator({ ...options, name: "api rate limit metrics" });

  const record = (observation: RateLimitObservation): void => {
    const tenant = observation.tenant;
    if (!tenant) {
      return;
    }
    metrics.record(tenant, observationUpdates(observation), () => limitUpdates(observation.config));
  };

  return {
    record,
    size: metrics.size,
    discard: metrics.discard,
    flush: metrics.flush,
    start: metrics.start,
  };
}

export type ApiRateLimitMetricsAggregator = ReturnType<typeof createApiRateLimitMetricsAggregator>;

function observationUpdates(observation: RateLimitObservation): MetricUpdate[] {
  return [
    {
      name: observation.success
        ? API_RATE_LIMIT_METRIC_NAMES.allowed
        : API_RATE_LIMIT_METRIC_NAMES.denied,
      reducer: "sum",
      value: 1,
    },
    {
      name: API_RATE_LIMIT_METRIC_NAMES.remainingMin,
      reducer: "min",
      value: Math.max(0, observation.remaining),
    },
  ];
}

function limitUpdates(config: RateLimiterConfig): MetricUpdate[] {
  const limits = rateLimitConfigToLimits(config);
  if (!limits) {
    return [];
  }
  return [
    { name: API_RATE_LIMIT_METRIC_NAMES.limitPerSecond, reducer: "first", value: limits.perSecond },
    { name: API_RATE_LIMIT_METRIC_NAMES.limitBurst, reducer: "first", value: limits.burst },
  ];
}
