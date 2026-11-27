import { isRunFriendlyId } from "~/components/dashboard-agent/run-id";
import { fenceUntrusted } from "../../gate/fence.server";

const ID_CHARS = 128;
const HANDLE_PART_CHARS = 256;
export const HANDLE_CHARS = 1_024;
export const CURSOR_CHARS = 16_384;
const HANDLE_PREFIX = "b64:";
const LEVELS = new Set(["TRACE", "DEBUG", "INFO", "WARN", "ERROR"]);

const HEX_ID = /^[0-9a-f]{1,64}$/;
const CLICKHOUSE_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,9})?$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const BASE64 = /^[A-Za-z0-9+/_-]+={0,2}$/;

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;

export function capText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const end = isHighSurrogate(text.charCodeAt(maxChars - 1)) ? maxChars - 1 : maxChars;
  return `${text.slice(0, end)}\n… (truncated, ${text.length} characters in total)`;
}

export const untrusted = (value: string, source: string, maxChars: number) =>
  fenceUntrusted(capText(value, maxChars), source);

const isHexId = (value: string) => HEX_ID.test(value);
const isClickhouseTime = (value: string) => CLICKHOUSE_TIME.test(value);
const isPlainRunId = (value: string) => value.length <= ID_CHARS && isRunFriendlyId(value);

const plainOr = (value: string, valid: (value: string) => boolean, source: string) =>
  valid(value) ? value : untrusted(value, source, ID_CHARS);

type LogKey = { traceId: string; spanId: string; startTime: string };

const rawStartTime = (id: string) => id.slice(id.lastIndexOf("::") + 2);

function logHandle(log: { id: string; traceId: string; spanId: string; runId: string }) {
  const key = { traceId: log.traceId, spanId: log.spanId, startTime: rawStartTime(log.id) };
  if (!isClickhouseTime(key.startTime)) return undefined;
  if (isHexId(key.traceId) && isHexId(key.spanId)) {
    const run = isPlainRunId(log.runId) ? log.runId : "-";
    return `${key.traceId}::${key.spanId}::${run}::${key.startTime}`;
  }
  if (key.traceId.length > HANDLE_PART_CHARS || key.spanId.length > HANDLE_PART_CHARS) {
    return undefined;
  }
  const encoded = Buffer.from(JSON.stringify([key.traceId, key.spanId, key.startTime]));
  const handle = `${HANDLE_PREFIX}${encoded.toString("base64url")}`;
  return handle.length > HANDLE_CHARS ? undefined : handle;
}

export function parseLogHandle(id: string): LogKey | null {
  if (id.length > HANDLE_CHARS) return null;
  if (id.startsWith(HANDLE_PREFIX)) {
    try {
      const parts: unknown = JSON.parse(
        Buffer.from(id.slice(HANDLE_PREFIX.length), "base64url").toString("utf8")
      );
      if (
        !Array.isArray(parts) ||
        parts.length !== 3 ||
        !parts.every((p) => typeof p === "string" && p.length <= HANDLE_PART_CHARS)
      ) {
        return null;
      }
      const [traceId, spanId, startTime] = parts as string[];
      return isClickhouseTime(startTime) ? { traceId, spanId, startTime } : null;
    } catch {
      return null;
    }
  }

  const parts = id.split("::");
  if (parts.length !== 4) return null;
  const [traceId, spanId, , startTime] = parts;
  return isHexId(traceId) && isHexId(spanId) && isClickhouseTime(startTime)
    ? { traceId, spanId, startTime }
    : null;
}

type LogRow = {
  id: string;
  runId: string;
  taskIdentifier: string;
  traceId: string;
  spanId: string;
  level: string;
  message: string;
};

export function renderLogRow(log: LogRow, messageChars: number) {
  const handle = logHandle(log);
  return {
    id: handle ?? "unavailable (this row's identifiers are too long to open with get_log)",
    level: plainOr(log.level, (v) => LEVELS.has(v), "log-level"),
    task: untrusted(log.taskIdentifier, "log-task", ID_CHARS),
    run: plainOr(log.runId, isPlainRunId, "log-run-id"),
    trace: plainOr(log.traceId, isHexId, "log-trace-id"),
    span: plainOr(log.spanId, isHexId, "log-span-id"),
    message: untrusted(log.message, "log-message", messageChars),
  };
}

export const renderTime = (value: string) =>
  ISO_TIME.test(value) ? value : untrusted(value, "log-time", ID_CHARS);

export const renderDuration = (nanoseconds: number) =>
  Number.isFinite(nanoseconds) && nanoseconds > 0 ? `${nanoseconds / 1_000_000}ms` : undefined;

export const renderCursor = (cursor: string) =>
  cursor.length <= CURSOR_CHARS && BASE64.test(cursor) ? cursor : undefined;
