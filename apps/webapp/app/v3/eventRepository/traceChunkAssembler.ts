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

export type TraceChunkSource = "stream" | "errors" | "deeplink";

type EventCount = {
  bySource: Map<TraceChunkSource, number>;
  pushed: number;
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

function parseMetadata(metadata: string): Record<string, unknown> | undefined {
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

export class TraceChunkAssembler {
  #nodes = new Map<string, SpanSummary>();
  #earliest = new Map<string, Date>();
  #earliestNano = new Map<string, bigint>();
  #firstNano = new Map<string, bigint>();
  #eventCounts = new Map<string, Map<string, EventCount>>();

  mergeChunk(events: TraceChunkEvent[], options?: { source?: TraceChunkSource }): void {
    const source = options?.source ?? "stream";
    for (const event of events) {
      this.#mergeEvent(event, source);
    }
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
      node.data.style = {
        icon: newStyle.icon ?? node.data.style.icon,
        variant: newStyle.variant ?? node.data.style.variant,
        accessory: newStyle.accessory ?? node.data.style.accessory,
      };
    }

    if (event.kind === "SPAN") {
      node.data.message = event.message;
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
    const key = JSON.stringify([
      event.kind,
      event.startTime.getTime(),
      event.message,
      event.metadata,
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

  flatten(rootSpanId: string): FlatTree<SpanSummary["data"]> {
    const tree = createTreeFromFlatItems(this.spans, rootSpanId);
    return tree ? flattenTree(tree) : [];
  }
}
