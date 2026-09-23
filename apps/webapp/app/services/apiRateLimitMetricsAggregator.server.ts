import type { MetricsV1Input } from "@internal/clickhouse";
import type {
  RateLimiterConfig,
  RateLimitObservation,
  RateLimitTenant,
} from "./authorizationRateLimitMiddleware.server";
import { logger } from "./logger.server";
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

export type ApiRateLimitMetricsAggregatorOptions = {
  bucketSeconds: number;
  /** Hard cap on distinct (environment, bucket) entries held between flushes. */
  maxEntries: number;
  /** Runtime gate, evaluated per observation once a tenant is known. */
  isEnabled: (tenant: RateLimitTenant) => boolean;
  /** Receives every flushed batch. A rejected promise or a throw is logged and the batch dropped. */
  sink: (rows: MetricsV1Input[]) => void | Promise<void>;
  now?: () => number;
  onDropped?: (count: number) => void;
};

type Entry = {
  organizationId: string;
  projectId: string;
  environmentId: string;
  bucketStartMs: number;
  allowed: number;
  denied: number;
  remainingMin: number;
  limits: RateLimitLimits | undefined;
};

/**
 * In-process counter for the API rate limiter's allow/deny decisions, keyed by
 * (environment, time bucket). Every flush emits the counts accumulated since the previous
 * flush as delta rows, so several replicas (or one replica across a flush boundary) may
 * emit rows for the same key and sum() at read time stays exact.
 */
export class ApiRateLimitMetricsAggregator {
  private readonly entries = new Map<string, Entry>();
  private readonly bucketMs: number;
  private readonly maxEntries: number;
  private readonly isEnabled: (tenant: RateLimitTenant) => boolean;
  private readonly sink: (rows: MetricsV1Input[]) => void | Promise<void>;
  private readonly now: () => number;
  private readonly onDropped?: (count: number) => void;

  constructor(options: ApiRateLimitMetricsAggregatorOptions) {
    this.bucketMs = options.bucketSeconds * 1000;
    this.maxEntries = options.maxEntries;
    this.isEnabled = options.isEnabled;
    this.sink = options.sink;
    this.now = options.now ?? Date.now;
    this.onDropped = options.onDropped;
  }

  get size(): number {
    return this.entries.size;
  }

  record(observation: RateLimitObservation): void {
    const tenant = observation.tenant;
    if (!tenant || !this.isEnabled(tenant)) {
      return;
    }

    const bucketStartMs = Math.floor(this.now() / this.bucketMs) * this.bucketMs;
    const key = `${tenant.environmentId}\0${bucketStartMs}`;
    const remaining = Math.max(0, observation.remaining);

    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= this.maxEntries) {
        this.onDropped?.(1);
        return;
      }
      entry = {
        organizationId: tenant.organizationId,
        projectId: tenant.projectId,
        environmentId: tenant.environmentId,
        bucketStartMs,
        allowed: 0,
        denied: 0,
        remainingMin: remaining,
        limits: rateLimitConfigToLimits(observation.config),
      };
      this.entries.set(key, entry);
    }

    if (observation.success) {
      entry.allowed++;
    } else {
      entry.denied++;
    }
    entry.remainingMin = Math.min(entry.remainingMin, remaining);
  }

  /**
   * Throws away everything held without emitting it and returns how many observations
   * were folded into the discarded entries, so callers can account for them as dropped.
   */
  discard(): number {
    let observations = 0;
    for (const entry of this.entries.values()) {
      observations += entry.allowed + entry.denied;
    }
    this.entries.clear();
    return observations;
  }

  flush(): number {
    if (this.entries.size === 0) {
      return 0;
    }

    const rows: MetricsV1Input[] = [];
    for (const entry of this.entries.values()) {
      rows.push(...entryToRows(entry));
    }
    this.entries.clear();

    const dropBatch = (error: unknown) => {
      logger.error("api rate limit metrics: sink failed, dropping batch", {
        rows: rows.length,
        error: error instanceof Error ? error.message : String(error),
      });
    };
    try {
      const result = this.sink(rows);
      if (result instanceof Promise) {
        result.catch(dropBatch);
      }
    } catch (error) {
      dropBatch(error);
    }

    return rows.length;
  }
}

function entryToRows(entry: Entry): MetricsV1Input[] {
  const base = {
    organization_id: entry.organizationId,
    project_id: entry.projectId,
    environment_id: entry.environmentId,
    metric_subject: "",
    bucket_start: formatBucketStart(entry.bucketStartMs),
    attributes: {},
  };

  const rows: MetricsV1Input[] = [];
  if (entry.allowed > 0) {
    rows.push({
      ...base,
      metric_name: API_RATE_LIMIT_METRIC_NAMES.allowed,
      metric_type: "sum",
      value: entry.allowed,
    });
  }
  if (entry.denied > 0) {
    rows.push({
      ...base,
      metric_name: API_RATE_LIMIT_METRIC_NAMES.denied,
      metric_type: "sum",
      value: entry.denied,
    });
  }
  rows.push({
    ...base,
    metric_name: API_RATE_LIMIT_METRIC_NAMES.remainingMin,
    metric_type: "gauge",
    value: entry.remainingMin,
  });
  if (entry.limits) {
    rows.push(
      {
        ...base,
        metric_name: API_RATE_LIMIT_METRIC_NAMES.limitPerSecond,
        metric_type: "gauge",
        value: entry.limits.perSecond,
      },
      {
        ...base,
        metric_name: API_RATE_LIMIT_METRIC_NAMES.limitBurst,
        metric_type: "gauge",
        value: entry.limits.burst,
      }
    );
  }
  return rows;
}

function formatBucketStart(epochMs: number): string {
  return new Date(epochMs)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, "");
}
