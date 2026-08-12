// Create a logger class that uses the debug package internally

/**
 * Represents different log levels.
 * - `"log"`: Only essential messages.
 * - `"error"`: Errors and essential messages.
 * - `"warn"`: Warnings, Errors and essential messages.
 * - `"info"`: Info, Warnings, Errors and essential messages.
 * - `"debug"`: Everything.
 */
import { env } from "node:process";
import { Buffer } from "node:buffer";
import { trace, context } from "@opentelemetry/api";

export type LogLevel = "log" | "error" | "warn" | "info" | "debug" | "verbose";

const logLevels: Array<LogLevel> = ["log", "error", "warn", "info", "debug", "verbose"];

// Applied to every Logger instance, on top of whatever a caller passes in as `filteredKeys`.
// Keeps the previous "opt-in, per-instance" list from being the only thing standing between a
// logged object and a credential or piece of customer content that happens to share its name.
const DEFAULT_FILTERED_KEYS = [
  "authorization",
  "token",
  "apikey",
  "secretkey",
  "accesstoken",
  "refreshtoken",
  "password",
  "jwt",
  "payload",
  "output",
  "metadata",
  "seedmetadata",
  "input",
  "email",
  "headers",
  "completedwaitpoints",
];

// Belt-and-braces value-shape check: catches secrets anywhere in values that land under a field
// name we didn't think to deny-list (a trigger.dev API key, bearer token, or OpenAI-style key).
const SECRET_VALUE_PATTERN = /(tr_[a-zA-Z0-9_-]{4,}|sk-[a-zA-Z0-9_-]{4,}|Bearer\s+\S+)/;

// Per-field and per-structure caps so a single unbounded object (a run payload, a batch of
// items, a DB row) can't blow up log line size or CPU. Truncation keeps the field present and
// queryable rather than dropping it.
const MAX_STRING_LENGTH = 8192;
const MAX_ARRAY_LENGTH = 100;
const MAX_DEPTH = 10;

function buildFilteredKeySet(filteredKeys: string[]): Set<string> {
  const set = new Set(DEFAULT_FILTERED_KEYS);

  for (const key of filteredKeys) {
    set.add(key.toLowerCase());
  }

  return set;
}

export class Logger {
  #name: string;
  readonly #level: number;
  #filteredKeys: Set<string> = new Set(DEFAULT_FILTERED_KEYS);
  #jsonReplacer?: (key: string, value: unknown) => unknown;
  #additionalFields: () => Record<string, unknown>;

  // Add a static "onError" method that will be called when an error is logged
  static onError: (message: string, ...args: Array<Record<string, unknown> | undefined>) => void;

  // Optional static sink called with the fully-structured log for every emitted line.
  // Used (e.g.) to fan logs out to a dev-only telnet stream. Must not re-enter the Logger.
  static onLog?: (structuredLog: Record<string, unknown>) => void;

  constructor(
    name: string,
    level: LogLevel = "info",
    filteredKeys: string[] = [],
    jsonReplacer?: (key: string, value: unknown) => unknown,
    additionalFields?: () => Record<string, unknown>
  ) {
    this.#name = name;
    this.#level = logLevels.indexOf((env.TRIGGER_LOG_LEVEL ?? level) as LogLevel);
    this.#filteredKeys = buildFilteredKeySet(filteredKeys);
    this.#jsonReplacer = createReplacer(jsonReplacer);
    this.#additionalFields = additionalFields ?? (() => ({}));
  }

  child(fields: Record<string, unknown>) {
    return new Logger(
      this.#name,
      logLevels[this.#level],
      Array.from(this.#filteredKeys),
      this.#jsonReplacer,
      () => ({ ...this.#additionalFields(), ...fields })
    );
  }

  // Return a new Logger instance with the same name and a new log level
  // but filter out the keys from the log messages (at any level)
  filter(...keys: string[]) {
    return new Logger(this.#name, logLevels[this.#level], keys, this.#jsonReplacer);
  }

  static satisfiesLogLevel(logLevel: LogLevel, setLevel: LogLevel) {
    return logLevels.indexOf(logLevel) <= logLevels.indexOf(setLevel);
  }

  log(message: string, ...args: Array<Record<string, unknown> | undefined>) {
    if (this.#level < 0) return;

    this.#structuredLog(console.log, message, "log", ...args);
  }

  error(message: string, ...args: Array<Record<string, unknown> | undefined>) {
    if (this.#level < 1) return;

    this.#structuredLog(console.error, message, "error", ...args);

    const ignoreError = args.some((arg) => arg?.ignoreError);

    if (Logger.onError && !ignoreError) {
      Logger.onError(message, ...args);
    }
  }

  warn(message: string, ...args: Array<Record<string, unknown> | undefined>) {
    if (this.#level < 2) return;

    this.#structuredLog(console.warn, message, "warn", ...args);
  }

  info(message: string, ...args: Array<Record<string, unknown> | undefined>) {
    if (this.#level < 3) return;

    this.#structuredLog(console.info, message, "info", ...args);
  }

  debug(message: string, ...args: Array<Record<string, unknown> | undefined>) {
    if (this.#level < 4) return;

    this.#structuredLog(console.debug, message, "debug", ...args);
  }

  verbose(message: string, ...args: Array<Record<string, unknown> | undefined>) {
    if (this.#level < 5) return;

    this.#structuredLog(console.log, message, "verbose", ...args);
  }

  #structuredLog(
    loggerFunction: (message: string, ...args: any[]) => void,
    message: string,
    level: string,
    ...args: Array<Record<string, unknown> | undefined>
  ) {
    // Get the current context from trace if it exists
    const currentSpan = trace.getSpan(context.active());

    const structuredError = extractStructuredErrorFromArgs(this.#filteredKeys, ...args);
    const structuredMessage = extractStructuredMessageFromArgs(this.#filteredKeys, ...args);

    const structuredLog = {
      ...structureArgs(safeJsonClone(args) as Record<string, unknown>[], this.#filteredKeys),
      ...this.#additionalFields(),
      ...(structuredError ? { error: structuredError } : {}),
      timestamp: new Date(),
      name: this.#name,
      message,
      ...(structuredMessage ? { $message: structuredMessage } : {}),
      level,
      traceId:
        currentSpan && currentSpan.isRecording() ? currentSpan?.spanContext().traceId : undefined,
      parentSpanId:
        currentSpan && currentSpan.isRecording() ? currentSpan?.spanContext().spanId : undefined,
    };

    // If the span is not recording, and it's a debug log, mark it so we can filter it out when we forward it
    if (currentSpan && !currentSpan.isRecording() && level === "debug") {
      structuredLog.skipForwarding = true;
    }

    if (Logger.onLog) {
      try {
        Logger.onLog(structuredLog);
      } catch {
        // A sink must never break logging — and must never re-enter the Logger.
      }
    }

    loggerFunction(JSON.stringify(structuredLog, this.#jsonReplacer));
  }
}

// Detect if args is an error object
// Or if args contains an error object at the "error" key
// In both cases, return the error object as a structured error
// Run every field through the same filter/truncation used for the rest of the log line, so an
// error's message/stack/metadata (which can embed request or row data verbatim) gets the same
// treatment as everything else, instead of bypassing it.
function extractStructuredErrorFromArgs(
  filteredKeys: Set<string>,
  ...args: Array<Record<string, unknown> | undefined>
) {
  const error = args.find((arg) => arg instanceof Error) as
    | (Error & { metadata?: unknown })
    | undefined;

  if (error) {
    return {
      message: filterKeys(error.message, filteredKeys),
      stack: filterKeys(error.stack, filteredKeys),
      name: error.name,
      metadata: "metadata" in error ? filterKeys(error.metadata, filteredKeys) : undefined,
    };
  }

  const structuredError = args.find((arg) => arg?.error);

  if (structuredError && structuredError.error instanceof Error) {
    const nestedError = structuredError.error as Error & { metadata?: unknown };

    return {
      message: filterKeys(nestedError.message, filteredKeys),
      stack: filterKeys(nestedError.stack, filteredKeys),
      name: nestedError.name,
      metadata:
        "metadata" in nestedError ? filterKeys(nestedError.metadata, filteredKeys) : undefined,
    };
  }

  return;
}

function extractStructuredMessageFromArgs(
  filteredKeys: Set<string>,
  ...args: Array<Record<string, unknown> | undefined>
) {
  // Check to see if there is a `message` key in the args, and if so, return it
  const structuredMessage = args.find((arg) => arg?.message);

  if (structuredMessage) {
    return filterKeys(structuredMessage.message, filteredKeys);
  }

  return;
}

function createReplacer(replacer?: (key: string, value: unknown) => unknown) {
  return (key: string, value: unknown) => {
    if (typeof value === "bigint") {
      return value.toString();
    }

    if (replacer) {
      return replacer(key, value);
    }

    return value;
  };
}

// Replacer function for JSON.stringify that converts BigInts to strings
function bigIntReplacer(_key: string, value: unknown) {
  if (typeof value === "bigint") {
    return value.toString();
  }

  return value;
}

function safeJsonClone(obj: unknown) {
  try {
    return JSON.parse(JSON.stringify(obj, bigIntReplacer));
  } catch (_e) {
    return;
  }
}

// `args` has already been through safeJsonClone, so this only has to filter/truncate it, not
// clone it again. If there's exactly one arg, return it directly (unwrapped) so it can be spread
// onto the structured log; otherwise filter every arg and return the array. Filtering runs
// regardless of arg count, so a multi-arg call gets the same redaction as the common single-arg
// case.
function structureArgs(
  args: Array<Record<string, unknown>> | undefined,
  filteredKeys: Set<string> = new Set()
) {
  if (!args || args.length === 0) {
    return;
  }

  const filteredArgs = args.map((arg) => filterKeys(arg, filteredKeys));

  if (filteredArgs.length === 1) {
    return filteredArgs[0];
  }

  return filteredArgs;
}

// Recursively filter out keys from an object, including nested objects and arrays. Also caps
// string length, array length and recursion depth, and redacts string values that look like a
// secret regardless of which key they were found under.
function filterKeys(obj: unknown, keys: Set<string>, depth = 0): any {
  if (typeof obj === "string") {
    if (SECRET_VALUE_PATTERN.test(obj)) {
      return `[filtered ${prettyPrintBytes(obj)}]`;
    }

    return truncateString(obj);
  }

  if (typeof obj !== "object" || obj === null) {
    return obj;
  }

  if (depth >= MAX_DEPTH) {
    return "[max depth exceeded]";
  }

  if (Array.isArray(obj)) {
    const isTruncated = obj.length > MAX_ARRAY_LENGTH;
    const items = (isTruncated ? obj.slice(0, MAX_ARRAY_LENGTH) : obj).map((item) =>
      filterKeys(item, keys, depth + 1)
    );

    if (isTruncated) {
      items.push(`[truncated ${obj.length - MAX_ARRAY_LENGTH} more items]`);
    }

    return items;
  }

  const filteredObj: any = {};

  for (const [key, value] of Object.entries(obj)) {
    if (keys.has(key.toLowerCase())) {
      if (value) {
        filteredObj[key] = `[filtered ${prettyPrintBytes(value)}]`;
      } else {
        filteredObj[key] = value;
      }
      continue;
    }

    filteredObj[key] = filterKeys(value, keys, depth + 1);
  }

  return filteredObj;
}

function truncateString(value: string): string {
  if (value.length <= MAX_STRING_LENGTH) {
    return value;
  }

  return `${value.slice(0, MAX_STRING_LENGTH)}...[truncated ${
    value.length - MAX_STRING_LENGTH
  } chars]`;
}

// Runs a value through the same default-deny-list + truncation pipeline every Logger applies to
// its own log lines. For destinations that receive log arguments through a side channel (e.g. an
// error reporting `onError` hook) rather than through `Logger#structuredLog` itself.
export function redact(value: unknown, filteredKeys: string[] = []): unknown {
  return filterKeys(value, buildFilteredKeySet(filteredKeys));
}

function prettyPrintBytes(value: unknown): string {
  if (env.NODE_ENV === "production") {
    return "skipped size";
  }

  const sizeInBytes = getSizeInBytes(value);

  if (sizeInBytes < 1024) {
    return `${sizeInBytes} bytes`;
  }

  if (sizeInBytes < 1024 * 1024) {
    return `${(sizeInBytes / 1024).toFixed(2)} KB`;
  }

  if (sizeInBytes < 1024 * 1024 * 1024) {
    return `${(sizeInBytes / (1024 * 1024)).toFixed(2)} MB`;
  }

  return `${(sizeInBytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function getSizeInBytes(value: unknown) {
  const jsonString = JSON.stringify(value);

  return Buffer.byteLength(jsonString, "utf8");
}
