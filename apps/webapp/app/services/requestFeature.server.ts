import { AsyncLocalStorage } from "node:async_hooks";
import { getMeter, trace } from "@internal/tracing";
import type { QueryObserver } from "@internal/clickhouse";
import { singleton } from "~/utils/singleton";

// A short fixed list: each name becomes a metric label value.
export type RequestFeatureName = "session.trace" | "run.trace";

export type RequestViewer = "member" | "admin" | "impersonating";

export type RequestFeatureDetails = {
  kind?: string;
  viewer?: RequestViewer;
  readContext?: string;
  // Adds a Server-Timing header with the request's ClickHouse rows and time.
  serverTiming?: boolean;
};

export type RequestFeatureState = RequestFeatureDetails & {
  feature: RequestFeatureName;
  clickhouse: { readRows: number; serverMs: number; queries: number };
};

const DURATION_BUCKETS_MS = [
  5, 10, 25, 50, 100, 150, 250, 300, 400, 500, 600, 700, 750, 1_000, 2_500, 5_000, 10_000,
];

const storage = new AsyncLocalStorage<RequestFeatureState>();

function telemetry() {
  return singleton("requestFeatureTelemetry", () => {
    const meter = getMeter("request-feature");

    return {
      duration: meter.createHistogram("feature_request.duration", {
        description: "Duration of requests to routes that opted into a feature label",
        unit: "ms",
        advice: { explicitBucketBoundaries: DURATION_BUCKETS_MS },
      }),
      fallbacks: meter.createCounter("feature_request.fallbacks", {
        description: "Items a feature couldn't show and sent to a fallback, by reason",
      }),
    };
  });
}

export const requestFeature = {
  get(): RequestFeatureState | undefined {
    return storage.getStore();
  },
  describe(details: RequestFeatureDetails): void {
    const state = storage.getStore();
    if (state) Object.assign(state, details);
  },
  recordFallback(source: string, reason: string, count = 1): void {
    const state = storage.getStore();
    if (!state || count <= 0) return;
    telemetry().fallbacks.add(count, { feature: state.feature, source, reason });
  },
};

export function viewerOf(user: { admin: boolean; isImpersonating?: boolean }): RequestViewer {
  if (user.isImpersonating) return "impersonating";
  return user.admin ? "admin" : "member";
}

/** Runs a route handler with a feature label; without one it runs unchanged. */
export async function withRequestFeature<T>(
  feature: RequestFeatureName | undefined,
  fn: () => Promise<T>
): Promise<T> {
  if (!feature) return fn();

  const state: RequestFeatureState = {
    feature,
    clickhouse: { readRows: 0, serverMs: 0, queries: 0 },
  };
  const startedAt = performance.now();

  return storage.run(state, async () => {
    try {
      const result = await fn();
      finish(state, startedAt, result instanceof Response ? result.status : 200);
      if (result instanceof Response) addServerTiming(state, result);
      return result;
    } catch (error) {
      finish(state, startedAt, error instanceof Response ? error.status : 500);
      throw error;
    }
  });
}

export const requestFeatureQueryObserver: QueryObserver = {
  metricAttributes() {
    const state = storage.getStore();
    if (!state) return undefined;
    return { feature: state.feature, read_context: state.readContext ?? "none" };
  },
  onQuery(observation) {
    const state = storage.getStore();
    if (!state) return;
    state.clickhouse.queries++;
    state.clickhouse.readRows += observation.readRows ?? 0;
    state.clickhouse.serverMs += observation.serverDurationMs ?? 0;
  },
};

function statusClass(status: number): string {
  return `${Math.floor(status / 100)}xx`;
}

function finish(state: RequestFeatureState, startedAt: number, status: number) {
  telemetry().duration.record(performance.now() - startedAt, {
    feature: state.feature,
    kind: state.kind ?? "other",
    status_class: statusClass(status),
    viewer: state.viewer ?? "unknown",
  });

  trace.getActiveSpan()?.setAttributes({
    "feature.name": state.feature,
    "feature.kind": state.kind ?? "other",
    "feature.clickhouse.queries": state.clickhouse.queries,
    "feature.clickhouse.read_rows": state.clickhouse.readRows,
    "feature.clickhouse.server_ms": Math.round(state.clickhouse.serverMs),
  });
}

function addServerTiming(state: RequestFeatureState, response: Response) {
  if (!state.serverTiming) return;
  const { readRows, serverMs } = state.clickhouse;
  response.headers.append(
    "Server-Timing",
    `clickhouse;dur=${serverMs.toFixed(1)};desc="${readRows} rows"`
  );
}
