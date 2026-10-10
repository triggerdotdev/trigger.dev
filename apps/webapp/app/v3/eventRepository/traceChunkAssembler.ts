import type { TaskEventLevel } from "@trigger.dev/database";
import type { TaskEventStyle } from "@trigger.dev/core/v3/schemas";
import {
  createTreeFromFlatItems,
  flattenTree,
  type FlatTree,
} from "~/components/primitives/TreeView/TreeView";
import type { SpanSummary, TraceChunkEvent } from "./eventRepository.types";

function kindToLevel(kind: string): TaskEventLevel {
  switch (kind) {
    case "DEBUG_EVENT":
    case "LOG_DEBUG":
      return "DEBUG";
    case "LOG_LOG":
      return "LOG";
    case "LOG_INFO":
      return "INFO";
    case "LOG_WARN":
      return "WARN";
    case "LOG_ERROR":
      return "ERROR";
    default:
      return "TRACE";
  }
}

function isLogEvent(kind: string): boolean {
  return kind.startsWith("LOG_") || kind === "DEBUG_EVENT";
}

export type TraceChunkSource = "stream" | "errors" | "deeplink" | "tail" | "revalidate";

// Each read from these sources is a whole re-read, so it replaces its own counts.
type ReplacingSource = "tail" | "deeplink" | "revalidate";

type EventCount = {
  bySource: Map<TraceChunkSource, number>;
  pushed: number;
  // Read generation when this key's count for each replacing source was last reset.
  readGen?: Partial<Record<ReplacingSource, number>>;
};

function parseNano(value: string): bigint | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return BigInt(value);
  } catch {
    return undefined;
  }
}

export function parseMetadata(metadata: string): Record<string, unknown> | undefined {
  if (!metadata) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(metadata);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

// The parts of a span the tree view renders.
type RenderedSpan = {
  message: string;
  isPartial: boolean;
  isError: boolean;
  isCancelled: boolean;
  duration: number;
  attemptNumber: number | undefined;
  startTimeMs: number;
  sortNano: bigint;
  eventCount: number;
  style: SpanSummary["data"]["style"];
};

function hasNodeChanged(before: RenderedSpan, after: RenderedSpan): boolean {
  if (before.message !== after.message) return true;
  if (before.isPartial !== after.isPartial) return true;
  if (before.isError !== after.isError) return true;
  if (before.isCancelled !== after.isCancelled) return true;
  if (before.duration !== after.duration) return true;
  if (before.attemptNumber !== after.attemptNumber) return true;
  if (before.startTimeMs !== after.startTimeMs) return true;
  if (before.sortNano !== after.sortNano) return true;
  if (before.eventCount !== after.eventCount) return true;
  if (before.style === after.style) return false;
  if (before.style.icon !== after.style.icon) return true;
  if (before.style.variant !== after.style.variant) return true;
  return JSON.stringify(before.style.accessory) !== JSON.stringify(after.style.accessory);
}

export class TraceChunkAssembler {
  #nodes = new Map<string, SpanSummary>();
  // Set when a merge changes what the tree renders; cleared by `markRendered`.
  #changedSinceRender = true;
  #earliest = new Map<string, Date>();
  #earliestNano = new Map<string, bigint>();
  #firstNano = new Map<string, bigint>();
  #eventCounts = new Map<string, Map<string, EventCount>>();
  #readGeneration: Record<ReplacingSource, number> = { tail: 0, deeplink: 0, revalidate: 0 };
  // Greatest write time (ms) from any source; null on the v1 store.
  #maxInsertedAt: number | null = null;
  // Point the last completed tail read everything up to; other sources never move it.
  #tailHighWater: number | null = null;
  // Write time the next tail must read back to. Pinned to the initial read time and
  // after a failed tick; released once a tail from that point completes.
  #tailFloor: number | null = null;
  #tailFloorHeld = false;

  mergeChunk(events: TraceChunkEvent[], options?: { source?: TraceChunkSource }): void {
    const source = options?.source ?? "stream";
    if (source === "deeplink" || source === "revalidate") {
      this.#readGeneration[source]++;
    }
    for (const event of events) {
      if (event.insertedAt) {
        const ms = Number(event.insertedAt);
        if (Number.isFinite(ms)) {
          this.#maxInsertedAt = Math.max(this.#maxInsertedAt ?? ms, ms);
        }
      }
      if (this.#changedSinceRender) {
        this.#mergeEvent(event, source);
        continue;
      }
      const before = this.#renderedSpan(event.spanId);
      this.#mergeEvent(event, source);
      const after = this.#renderedSpan(event.spanId);
      if (!before || !after || hasNodeChanged(before, after)) {
        this.#changedSinceRender = true;
      }
    }
  }

  get changedSinceRender(): boolean {
    return this.#changedSinceRender;
  }

  markRendered(): void {
    this.#changedSinceRender = false;
  }

  #renderedSpan(spanId: string): RenderedSpan | undefined {
    const node = this.#nodes.get(spanId);
    if (!node) return undefined;
    const d = node.data;
    return {
      message: d.message,
      isPartial: d.isPartial,
      isError: d.isError,
      isCancelled: d.isCancelled,
      duration: d.duration,
      attemptNumber: d.attemptNumber,
      startTimeMs: d.startTime.getTime(),
      sortNano: this.#sortNano(spanId),
      eventCount: d.events.length,
      style: d.style,
    };
  }

  #mergeEvent(event: TraceChunkEvent, source: TraceChunkSource): void {
    const isOverrideOrSpanEvent = event.kind === "ANCESTOR_OVERRIDE" || event.kind === "SPAN_EVENT";

    const nano = parseNano(event.startTimeNano);
    if (nano !== undefined && !this.#firstNano.has(event.spanId)) {
      this.#firstNano.set(event.spanId, nano);
    }

    if (!isOverrideOrSpanEvent) {
      const previous = this.#earliest.get(event.spanId);
      if (!previous || event.startTime < previous) {
        this.#earliest.set(event.spanId, event.startTime);
      }
      if (nano !== undefined) {
        const previousNano = this.#earliestNano.get(event.spanId);
        if (previousNano === undefined || nano < previousNano) {
          this.#earliestNano.set(event.spanId, nano);
        }
      }
    }

    let node = this.#nodes.get(event.spanId);

    if (!node) {
      node = {
        id: event.spanId,
        parentId: event.parentSpanId ? event.parentSpanId : undefined,
        runId: event.runId,
        data: {
          message: event.message,
          style: {},
          duration: event.duration,
          isError: false,
          isPartial: true,
          isCancelled: false,
          isDebug: event.kind === "DEBUG_EVENT",
          startTime: event.startTime,
          level: kindToLevel(event.kind),
          events: [],
        },
      };
      this.#nodes.set(event.spanId, node);
    }

    if (isLogEvent(event.kind)) {
      node.data.isPartial = false;
      node.data.isCancelled = false;
      node.data.isError = event.status === "ERROR";
    }

    const parsedMetadata = parseMetadata(event.metadata);
    // An older PARTIAL row of a span that already has its final row must not overwrite
    // it, so merging gives the same result in any order (rows of one key arrive unordered).
    const isStalePartial =
      event.kind === "SPAN" && event.status === "PARTIAL" && !node.data.isPartial;

    if (
      parsedMetadata &&
      "attemptNumber" in parsedMetadata &&
      typeof parsedMetadata.attemptNumber === "number"
    ) {
      node.data.attemptNumber = parsedMetadata.attemptNumber;
    }

    if (isOverrideOrSpanEvent && this.#recordEventRow(event, source)) {
      node.data.events.push({
        name: event.message,
        time: event.startTime,
        properties: parsedMetadata ?? {},
      });
    }

    if (parsedMetadata && "style" in parsedMetadata && parsedMetadata.style) {
      const newStyle = parsedMetadata.style as TaskEventStyle;
      const current = node.data.style;
      node.data.style = isStalePartial
        ? {
            icon: current.icon ?? newStyle.icon,
            variant: current.variant ?? newStyle.variant,
            accessory: current.accessory ?? newStyle.accessory,
          }
        : {
            icon: newStyle.icon ?? current.icon,
            variant: newStyle.variant ?? current.variant,
            accessory: newStyle.accessory ?? current.accessory,
          };
    }

    if (event.kind === "SPAN") {
      if (!isStalePartial) {
        node.data.message = event.message;
      }
      if (event.status === "ERROR") {
        node.data.isError = true;
        node.data.isPartial = false;
        node.data.isCancelled = false;
      } else if (event.status === "CANCELLED") {
        node.data.isCancelled = true;
        node.data.isPartial = false;
        node.data.isError = false;
      } else if (event.status === "OK") {
        node.data.isPartial = false;
      }

      if (event.status !== "PARTIAL") {
        node.data.duration = event.duration;
      }
    }

    const earliest = this.#earliest.get(event.spanId);
    if (earliest) {
      node.data.startTime = earliest;
    }
  }

  #recordEventRow(event: TraceChunkEvent, source: TraceChunkSource): boolean {
    // Write time keeps identical events written at different times distinct.
    const key = JSON.stringify([
      event.kind,
      event.startTime.getTime(),
      event.message,
      event.metadata,
      event.insertedAt ?? "",
    ]);
    let bySpan = this.#eventCounts.get(event.spanId);
    if (!bySpan) {
      bySpan = new Map<string, EventCount>();
      this.#eventCounts.set(event.spanId, bySpan);
    }
    let count = bySpan.get(key);
    if (!count) {
      count = { bySource: new Map(), pushed: 0 };
      bySpan.set(key, count);
    }

    // Replace this source's count from its previous read; `pushed` only grows.
    if (source === "tail" || source === "deeplink" || source === "revalidate") {
      const generation = this.#readGeneration[source];
      if (count.readGen?.[source] !== generation) {
        count.readGen = { ...count.readGen, [source]: generation };
        count.bySource.set(source, 0);
      }
    }

    count.bySource.set(source, (count.bySource.get(source) ?? 0) + 1);

    let target = 0;
    for (const n of count.bySource.values()) {
      if (n > target) target = n;
    }
    if (target > count.pushed) {
      count.pushed = target;
      return true;
    }
    return false;
  }

  get spans(): SpanSummary[] {
    return Array.from(this.#nodes.values()).sort((a, b) => {
      const an = this.#sortNano(a.id);
      const bn = this.#sortNano(b.id);
      if (an !== bn) {
        return an < bn ? -1 : 1;
      }
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  }

  #sortNano(spanId: string): bigint {
    const earliest = this.#earliestNano.get(spanId);
    if (earliest !== undefined) {
      return earliest;
    }
    // Malformed nanosecond: fall back to the span's own millisecond start.
    const earliestMs = this.#earliest.get(spanId);
    if (earliestMs !== undefined) {
      return BigInt(earliestMs.getTime()) * 1_000_000n;
    }
    const first = this.#firstNano.get(spanId);
    if (first !== undefined) {
      return first;
    }
    const node = this.#nodes.get(spanId);
    return node ? BigInt(node.data.startTime.getTime()) * 1_000_000n : 0n;
  }

  hasSpan(spanId: string): boolean {
    return this.#nodes.has(spanId);
  }

  get size(): number {
    return this.#nodes.size;
  }

  // Next tail's starting write time; null when rows have none (v1 or empty).
  tailBase(): number | null {
    if (this.#maxInsertedAt === null) {
      return null;
    }
    if (this.#tailFloor === null) {
      return this.#tailHighWater ?? this.#maxInsertedAt;
    }
    return this.#tailHighWater === null
      ? this.#tailFloor
      : Math.min(this.#tailFloor, this.#tailHighWater);
  }

  // Call once per tail tick, before merging its pages.
  beginTailRead(): void {
    this.#readGeneration.tail++;
  }

  // While held (the background load is running), a completed tail keeps the floor.
  holdTailFloor(held: boolean): void {
    this.#tailFloorHeld = held;
  }

  pinTailFloor(ms: number): void {
    this.#tailFloor = this.#tailFloor === null ? ms : Math.min(this.#tailFloor, ms);
  }

  // A tail from `base` finished; `readThrough` is when its first page was read. Later
  // tails start from there, never from a later page's rows.
  completeTailRead(base: number, readThrough: number | null): void {
    this.#tailHighWater = Math.max(readThrough ?? this.#tailHighWater ?? base, base);
    if (this.#tailFloorHeld) return;
    if (this.#tailFloor !== null && this.#tailFloor >= base) {
      this.#tailFloor = null;
    }
  }

  flatten(rootSpanId: string): FlatTree<SpanSummary["data"]> {
    const tree = createTreeFromFlatItems(this.spans, rootSpanId);
    return tree ? flattenTree(tree) : [];
  }
}
