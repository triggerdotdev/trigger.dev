import type { MetricsV1Input } from "@internal/clickhouse";
import { logger } from "./logger.server";
import { signalsEmitter } from "./signals.server";

export type MetricsTenant = {
  organizationId: string;
  projectId: string;
  environmentId: string;
};

type MetricsCounter = {
  add(value: number, attributes?: Record<string, string>): void;
};

type MetricReducer = "sum" | "max" | "min" | "first" | "last";

type MetricOptions = {
  subject?: string;
  attributes?: Record<string, unknown>;
};

export type MetricUpdate = MetricOptions & {
  name: string;
  reducer: MetricReducer;
  value: number;
};

export type MetricsAggregatorOptions<TTenant extends MetricsTenant> = {
  /** Prefix for log messages. */
  name: string;
  bucketSeconds: number;
  /** Hard cap on distinct (environment, bucket) entries held between flushes. */
  maxEntries: number;
  /** Cap on distinct non-empty subjects per entry; updates for new subjects past it are dropped. */
  maxSubjectsPerEntry?: number;
  /** Runtime gate, evaluated per observation. */
  isEnabled: (tenant: TTenant) => boolean;
  /** Receives every flushed batch. A rejected promise or a throw is logged and the batch dropped. */
  sink: (rows: MetricsV1Input[]) => void | Promise<void>;
  counters?: { dropped?: MetricsCounter; rowsFlushed?: MetricsCounter };
  flushIntervalMs?: number;
  /** Timer flushes wait for this; shutting down before it resolves discards what is held. */
  ready?: Promise<unknown>;
  now?: () => number;
};

export type MetricsCell = {
  name: string;
  subject: string;
  reducer: MetricReducer;
  value: number;
  attributes: Record<string, unknown>;
};

export type MetricsEntry = {
  organizationId: string;
  projectId: string;
  environmentId: string;
  bucketStartMs: number;
  observations: number;
  subjects: Set<string>;
  cells: Map<string, MetricsCell>;
};

export function bucketStart(nowMs: number, bucketSeconds: number): number {
  const bucketMs = bucketSeconds * 1000;
  return Math.floor(nowMs / bucketMs) * bucketMs;
}

export function cellKey(update: MetricUpdate): string {
  return `${update.name}\0${update.subject ?? ""}\0${attributesKey(update.attributes)}`;
}

/** Folds an update into its cell; the first update fixes the cell's reducer and attributes. */
export function applyUpdate(cell: MetricsCell | undefined, update: MetricUpdate): MetricsCell {
  if (!cell) {
    return {
      name: update.name,
      subject: update.subject ?? "",
      reducer: update.reducer,
      value: update.value,
      attributes: update.attributes ?? {},
    };
  }
  return { ...cell, value: reduce(cell.reducer, cell.value, update.value) };
}

export function toRows(entries: Iterable<MetricsEntry>): MetricsV1Input[] {
  return Array.from(entries).flatMap((entry) => {
    const bucket_start = formatBucketStart(entry.bucketStartMs);
    return Array.from(entry.cells.values(), (cell) => ({
      organization_id: entry.organizationId,
      project_id: entry.projectId,
      environment_id: entry.environmentId,
      metric_name: cell.name,
      metric_type: cell.reducer === "sum" ? "sum" : "gauge",
      metric_subject: cell.subject,
      bucket_start,
      value: cell.value,
      attributes: cell.attributes,
    }));
  });
}

/**
 * In-process aggregator for metrics_v1 rows, keyed by (environment, bucket, name, subject,
 * attributes). Every flush emits what accumulated since the previous flush, so sum rows are deltas.
 */
export function createMetricsAggregator<TTenant extends MetricsTenant>(
  options: MetricsAggregatorOptions<TTenant>
) {
  const entries = new Map<string, MetricsEntry>();
  const now = options.now ?? Date.now;
  let interval: ReturnType<typeof setInterval> | undefined;
  let routingReady = !options.ready;
  let deferredWarned = false;

  options.ready
    ?.then(() => {
      routingReady = true;
    })
    .catch((error) => {
      logger.error(`${options.name}: data store registry never became ready`, {
        error: errorMessage(error),
      });
    });

  /**
   * Applies several updates as one observation: all are kept, or all are dropped at the cap.
   * onCreate runs only when this observation opens a new (environment, bucket) entry.
   */
  const record = (
    tenant: TTenant,
    updates: MetricUpdate[],
    onCreate?: () => MetricUpdate[]
  ): void => {
    if (!options.isEnabled(tenant)) {
      return;
    }

    const bucketStartMs = bucketStart(now(), options.bucketSeconds);
    const key = `${tenant.environmentId}\0${bucketStartMs}`;

    let entry = entries.get(key);
    if (!entry) {
      if (entries.size >= options.maxEntries) {
        options.counters?.dropped?.add(1, { reason: "cap" });
        return;
      }
      if (onCreate) {
        updates = [...updates, ...onCreate()];
      }
      entry = {
        organizationId: tenant.organizationId,
        projectId: tenant.projectId,
        environmentId: tenant.environmentId,
        bucketStartMs,
        observations: 0,
        subjects: new Set(),
        cells: new Map(),
      };
      entries.set(key, entry);
    }

    entry.observations++;
    for (const update of updates) {
      const subject = update.subject ?? "";
      if (subject && !entry.subjects.has(subject)) {
        if (entry.subjects.size >= (options.maxSubjectsPerEntry ?? Infinity)) {
          options.counters?.dropped?.add(1, { reason: "subjects" });
          continue;
        }
        entry.subjects.add(subject);
      }
      const cell = cellKey(update);
      entry.cells.set(cell, applyUpdate(entry.cells.get(cell), update));
    }
  };

  const count = (tenant: TTenant, name: string, delta: number, metric?: MetricOptions): void =>
    record(tenant, [{ ...metric, name, reducer: "sum", value: delta }]);

  /** Throws away everything held and returns how many observations it folded. */
  const discard = (): number => {
    let observations = 0;
    for (const entry of entries.values()) {
      observations += entry.observations;
    }
    entries.clear();
    return observations;
  };

  const flush = (): number => {
    if (entries.size === 0) {
      return 0;
    }
    const rows = toRows(entries.values());
    entries.clear();

    const dropBatch = (error: unknown) => {
      logger.error(`${options.name}: sink failed, dropping batch`, {
        rows: rows.length,
        error: errorMessage(error),
      });
    };
    try {
      const result = options.sink(rows);
      if (result instanceof Promise) {
        result.catch(dropBatch);
      }
    } catch (error) {
      dropBatch(error);
    }

    if (rows.length > 0) {
      options.counters?.rowsFlushed?.add(rows.length);
    }
    return rows.length;
  };

  const timerFlush = (): void => {
    if (!routingReady) {
      if (entries.size > 0 && !deferredWarned) {
        deferredWarned = true;
        logger.warn(`${options.name}: flush deferred, data store routing not ready`, {
          pendingEntries: entries.size,
        });
      }
      return;
    }
    try {
      flush();
    } catch (error) {
      logger.error(`${options.name}: flush failed`, { error: errorMessage(error) });
    }
  };

  const stop = (): void => {
    if (!interval) {
      return;
    }
    clearInterval(interval);
    interval = undefined;
    signalsEmitter.off("SIGTERM", stop);
    signalsEmitter.off("SIGINT", stop);

    if (!routingReady) {
      const dropped = discard();
      if (dropped > 0) {
        options.counters?.dropped?.add(dropped, { reason: "shutdown_before_ready" });
        logger.warn(`${options.name}: shutting down before routing was ready, dropping`, {
          droppedObservations: dropped,
        });
      }
      return;
    }
    timerFlush();
  };

  /** Starts the flush timer and flushes once more on SIGTERM/SIGINT. */
  const start = (): void => {
    if (interval || !options.flushIntervalMs) {
      return;
    }
    interval = setInterval(timerFlush, options.flushIntervalMs);
    interval.unref();
    signalsEmitter.on("SIGTERM", stop);
    signalsEmitter.on("SIGINT", stop);
  };

  return {
    count,
    record,
    flush,
    discard,
    size: () => entries.size,
    start,
    stop,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function attributesKey(attributes: Record<string, unknown> | undefined): string {
  if (!attributes) {
    return "";
  }
  const keys = Object.keys(attributes);
  return keys.length === 0 ? "" : JSON.stringify(attributes, keys.sort());
}

function reduce(reducer: MetricReducer, current: number, next: number): number {
  switch (reducer) {
    case "sum":
      return current + next;
    case "max":
      return Math.max(current, next);
    case "min":
      return Math.min(current, next);
    case "first":
      return current;
    case "last":
      return next;
  }
}

function formatBucketStart(epochMs: number): string {
  return new Date(epochMs)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, "");
}
