import { formatDurationNanoseconds } from "@trigger.dev/core/v3/utils/durations";
import type { StreamedTraceEvent } from "./eventRepository.types";

// Lines are batched into ~64KB chunks before being yielded to the gzip stream:
// per-line chunks make `Readable.from` ~10x slower, while chunks this size keep
// the pipe fed yet stay small enough to release the event loop frequently.
const DEFAULT_FLUSH_BYTES = 64 * 1024;

export type TraceExportContext = {
  runFriendlyId: string;
  traceId: string;
  taskIdentifier?: string;
  /** Absolute dashboard URL for the run (used by formats that link out). */
  runUrl?: string;
};

/**
 * A trace export format. `formatEvent` renders one {@link StreamedTraceEvent} to
 * a string; `header`/`footer` bookend the stream. Formats are intentionally
 * stateless across events so the export stays O(1) memory — see
 * {@link streamTraceExport}.
 */
export type TraceExportFormat = {
  name: TraceExportFormatName;
  extension: string;
  header?: (ctx: TraceExportContext) => string;
  formatEvent: (event: StreamedTraceEvent, ctx: TraceExportContext) => string;
  footer?: (ctx: TraceExportContext) => string;
};

export type TraceExportFormatName = "log" | "jsonl" | "markdown";

/**
 * Streams a trace export by piping events through a {@link TraceExportFormat}.
 * Batches output into ~`flushBytes` chunks and releases the event loop between
 * flushes; holds nothing across events but the buffer, so an arbitrarily large
 * trace exports in bounded memory regardless of format.
 */
export async function* streamTraceExport(
  events: AsyncIterable<StreamedTraceEvent>,
  format: TraceExportFormat,
  ctx: TraceExportContext,
  options: { flushBytes?: number } = {}
): AsyncGenerator<string> {
  const flushBytes = options.flushBytes ?? DEFAULT_FLUSH_BYTES;

  let buffer = format.header ? format.header(ctx) : "";

  for await (const event of events) {
    buffer += format.formatEvent(event, ctx);
    if (buffer.length >= flushBytes) {
      yield buffer;
      buffer = "";
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  if (format.footer) {
    buffer += format.footer(ctx);
  }

  if (buffer.length > 0) {
    yield buffer;
  }
}

function hasProperties(propertiesText: string): boolean {
  const trimmed = propertiesText.trim();
  return trimmed.length > 0 && trimmed !== "{}";
}

// For error events, pull the error message out of the properties so formats can
// surface it inline instead of burying it in the JSON blob. Only parses when the
// event is actually an error (rare), so the common path stays parse-free. Handles
// both trigger.dev's `error.*` shape and OTel's `exception.*` shape; the full
// object (incl. stacktrace) still rides along in the properties.
function errorMessage(event: StreamedTraceEvent): string | undefined {
  if (!event.isError || !hasProperties(event.propertiesText)) return undefined;
  try {
    const props = JSON.parse(event.propertiesText) as {
      error?: { message?: unknown };
      exception?: { message?: unknown };
    };
    const message = props.error?.message ?? props.exception?.message;
    return typeof message === "string" && message.length > 0
      ? message.replace(/\s+/g, " ").trim()
      : undefined;
  } catch {
    return undefined;
  }
}

function lineage(event: StreamedTraceEvent): string {
  return event.parentSpanId ? `${event.spanId} ← ${event.parentSpanId}` : event.spanId;
}

// ---------------------------------------------------------------------------
// log — flat, chronological, grep-friendly. One line per event (+ a props line).
// ---------------------------------------------------------------------------
const logFormat: TraceExportFormat = {
  name: "log",
  extension: "txt",
  formatEvent(event) {
    const time = event.startTime.toISOString();
    const level = event.level.padEnd(5);
    const errMsg = errorMessage(event);
    const status = event.isError ? (errMsg ? ` [ERROR: ${errMsg}]` : " [ERROR]") : "";
    const duration =
      event.durationNs > 0 ? ` (${formatDurationNanoseconds(event.durationNs)})` : "";

    let out = `${time} ${level} [${lineage(event)}] ${event.message}${status}${duration}\n`;
    if (hasProperties(event.propertiesText)) {
      out += `    props: ${event.propertiesText.trim()}\n`;
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// jsonl — one JSON object per line, properties inlined as a nested object.
// ---------------------------------------------------------------------------
const jsonlFormat: TraceExportFormat = {
  name: "jsonl",
  extension: "jsonl",
  formatEvent(event) {
    let properties: unknown = undefined;
    if (hasProperties(event.propertiesText)) {
      try {
        properties = JSON.parse(event.propertiesText);
      } catch {
        properties = event.propertiesText;
      }
    }

    return (
      JSON.stringify({
        time: event.startTime.toISOString(),
        level: event.level,
        spanId: event.spanId,
        parentSpanId: event.parentSpanId || undefined,
        message: event.message,
        durationNs: event.durationNs,
        isError: event.isError || undefined,
        errorMessage: errorMessage(event),
        properties,
      }) + "\n"
    );
  },
};

// ---------------------------------------------------------------------------
// markdown — AI-friendly: YAML frontmatter (ids, task, dashboard URL) + a
// scannable table, one row per event. Properties stay (inline code) so the
// export isn't lossy; a column-friendly cell escaper keeps the table intact.
// ---------------------------------------------------------------------------
function mdCell(value: string): string {
  // Pipes and newlines would break the table row; escape/flatten them. (GFM
  // treats `\|` inside a table cell — including code spans — as a literal pipe.)
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

const markdownFormat: TraceExportFormat = {
  name: "markdown",
  extension: "md",
  header(ctx) {
    const lines = ["---", `run: ${ctx.runFriendlyId}`, `trace: ${ctx.traceId}`];
    if (ctx.taskIdentifier) lines.push(`task: ${ctx.taskIdentifier}`);
    if (ctx.runUrl) lines.push(`url: ${ctx.runUrl}`);
    lines.push("---", "", `# Trace for ${ctx.runFriendlyId}`, "");
    if (ctx.runUrl) {
      lines.push(`[View in dashboard](${ctx.runUrl})`, "");
    }
    lines.push(
      "| time | level | event | duration | span ← parent | properties |",
      "| --- | --- | --- | --- | --- | --- |"
    );
    return lines.join("\n") + "\n";
  },
  formatEvent(event) {
    const time = event.startTime.toISOString();
    const level = event.isError ? `${event.level} ❌` : event.level;
    const duration = event.durationNs > 0 ? formatDurationNanoseconds(event.durationNs) : "—";
    const lineage = event.parentSpanId ? `${event.spanId} ← ${event.parentSpanId}` : event.spanId;
    const errMsg = errorMessage(event);
    const eventCell = errMsg ? `${event.message} — ${errMsg}` : event.message;
    const properties = hasProperties(event.propertiesText)
      ? "`" + mdCell(event.propertiesText.trim()) + "`"
      : "—";

    return `| ${time} | ${level} | ${mdCell(eventCell)} | ${duration} | \`${lineage}\` | ${properties} |\n`;
  },
};

const FORMATS: Record<TraceExportFormatName, TraceExportFormat> = {
  log: logFormat,
  jsonl: jsonlFormat,
  markdown: markdownFormat,
};

/** Resolve a `?format=` value to a format, defaulting to `log`. */
export function getTraceExportFormat(name: string | null | undefined): TraceExportFormat {
  if (name && Object.prototype.hasOwnProperty.call(FORMATS, name)) {
    return FORMATS[name as TraceExportFormatName];
  }
  return logFormat;
}
