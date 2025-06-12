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

export class Logger {
  #name: string;
  readonly #level: number;
  #filteredKeys: string[] = [];
  #jsonReplacer?: (key: string, value: unknown) => unknown;
  #additionalFields: () => Record<string, unknown>;

  constructor(
    name: string,
    level: LogLevel = "info",
    filteredKeys: string[] = [],
    jsonReplacer?: (key: string, value: unknown) => unknown,
    additionalFields?: () => Record<string, unknown>
  ) {
    this.#name = name;
    this.#level = logLevels.indexOf((env.TRIGGER_LOG_LEVEL ?? level) as LogLevel);
    this.#filteredKeys = filteredKeys;
    this.#jsonReplacer = createReplacer(jsonReplacer);
    this.#additionalFields = additionalFields ?? (() => ({}));
  }

  child(fields: Record<string, unknown>) {
    return new Logger(
      this.#name,
      logLevels[this.#level],
      this.#filteredKeys,
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

    const structuredError = extractStructuredErrorFromArgs(...args);
    const structuredMessage = extractStructuredMessageFromArgs(...args);

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

    loggerFunction(JSON.stringify(structuredLog, this.#jsonReplacer));
  }
}

// Detect if args is an error object
// Or if args contains an error object at the "error" key
// In both cases, return the error object as a structured error
function extractStructuredErrorFromArgs(...args: Array<Record<string, unknown> | undefined>) {
  const error = args.find((arg) => arg instanceof Error) as Error | undefined;

  if (error) {
    return {
      message: error.message,
      stack: error.stack,
      name: error.name,
    };
  }

  const structuredError = args.find((arg) => arg?.error);

  if (structuredError && structuredError.error instanceof Error) {
    return {
      message: structuredError.error.message,
      stack: structuredError.error.stack,
      name: structuredError.error.name,
    };
  }

  return;
}

function extractStructuredMessageFromArgs(...args: Array<Record<string, unknown> | undefined>) {
  // Check to see if there is a `message` key in the args, and if so, return it
  const structuredMessage = args.find((arg) => arg?.message);

  if (structuredMessage) {
    return structuredMessage.message;
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
  } catch (e) {
    return;
  }
}

// If args is has a single item that is an object, return that object
function structureArgs(args: Array<Record<string, unknown>>, filteredKeys: string[] = []) {
  if (!args) {
    return;
  }

  if (args.length === 0) {
    return;
  }

  if (args.length === 1 && typeof args[0] === "object") {
    return filterKeys(JSON.parse(JSON.stringify(args[0], bigIntReplacer)), filteredKeys);
  }

  return args;
}

// Recursively filter out keys from an object, including nested objects, and arrays
function filterKeys(obj: unknown, keys: string[]): any {
  if (typeof obj !== "object" || obj === null) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => filterKeys(item, keys));
  }

  const filteredObj: any = {};

  for (const [key, value] of Object.entries(obj)) {
    if (keys.includes(key)) {
      if (value) {
        filteredObj[key] = `[filtered ${prettyPrintBytes(value)}]`;
      } else {
        filteredObj[key] = value;
      }
      continue;
    }

    filteredObj[key] = filterKeys(value, keys);
  }

  return filteredObj;
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
