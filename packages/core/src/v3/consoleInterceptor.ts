import type * as logsAPI from "@opentelemetry/api-logs";
import { SeverityNumber } from "@opentelemetry/api-logs";
import util from "node:util";
import { iconStringForSeverity } from "./icons.js";
import { SemanticInternalAttributes } from "./semanticInternalAttributes.js";
import { flattenAttributes } from "./utils/flattenAttributes.js";
import { ClockTime } from "./clock/clock.js";
import { clock } from "./clock-api.js";

export class ConsoleInterceptor {
  constructor(
    private readonly logger: logsAPI.Logger,
    private readonly sendToStdIO: boolean,
    private readonly interceptingDisabled: boolean
  ) {}

  // Intercept the console and send logs to the OpenTelemetry logger
  // during the execution of the callback
  async intercept<T>(console: Console, callback: () => Promise<T>): Promise<T> {
    if (this.interceptingDisabled) {
      return await callback();
    }

    // Save the original console methods
    const originalConsole = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
      debug: console.debug,
    };

    // Override the console methods
    console.log = this.log.bind(this);
    console.info = this.info.bind(this);
    console.warn = this.warn.bind(this);
    console.error = this.error.bind(this);
    console.debug = this.debug.bind(this);

    try {
      return await callback();
    } finally {
      // Restore the original console methods
      console.log = originalConsole.log;
      console.info = originalConsole.info;
      console.warn = originalConsole.warn;
      console.error = originalConsole.error;
      console.debug = originalConsole.debug;
    }
  }

  debug(...args: unknown[]): void {
    this.#handleLog(SeverityNumber.DEBUG, this.#getTimestampInHrTime(), "Debug", ...args);
  }

  log(...args: unknown[]): void {
    this.#handleLog(SeverityNumber.INFO, this.#getTimestampInHrTime(), "Log", ...args);
  }

  info(...args: unknown[]): void {
    this.#handleLog(SeverityNumber.INFO, this.#getTimestampInHrTime(), "Info", ...args);
  }

  warn(...args: unknown[]): void {
    this.#handleLog(SeverityNumber.WARN, this.#getTimestampInHrTime(), "Warn", ...args);
  }

  error(...args: unknown[]): void {
    this.#handleLog(SeverityNumber.ERROR, this.#getTimestampInHrTime(), "Error", ...args);
  }

  #handleLog(
    severityNumber: SeverityNumber,
    timestamp: ClockTime,
    severityText: string,
    ...args: unknown[]
  ): void {
    const body = util.format(...args);

    if (this.sendToStdIO) {
      if (severityNumber === SeverityNumber.ERROR) {
        process.stderr.write(body);
      } else {
        process.stdout.write(body);
      }
    }

    const parsed = tryParseJSON(body);

    if (parsed.ok) {
      this.logger.emit({
        severityNumber,
        severityText,
        body: getLogMessage(parsed.value, severityText),
        attributes: { ...this.#getAttributes(severityNumber), ...flattenAttributes(parsed.value) },
        timestamp,
      });

      return;
    }

    this.logger.emit({
      severityNumber,
      severityText,
      body,
      attributes: this.#getAttributes(severityNumber),
      timestamp,
    });
  }

  #getTimestampInHrTime(): ClockTime {
    return clock.preciseNow();
  }

  #getAttributes(severityNumber: SeverityNumber): logsAPI.LogAttributes {
    const icon = iconStringForSeverity(severityNumber);
    let result: logsAPI.LogAttributes = {};

    if (icon !== undefined) {
      result[SemanticInternalAttributes.STYLE_ICON] = icon;
    }

    return result;
  }
}

function getLogMessage(value: Record<string, unknown>, fallback: string): string {
  if (typeof value["message"] === "string") {
    return value["message"];
  }

  if (typeof value["msg"] === "string") {
    return value["msg"];
  }

  if (typeof value["body"] === "string") {
    return value["body"];
  }

  if (typeof value["error"] === "string") {
    return value["error"];
  }

  return fallback;
}

function tryParseJSON(
  value: string
): { ok: true; value: Record<string, unknown> } | { ok: false; value: string } {
  try {
    const parsed = JSON.parse(value);

    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return { ok: true, value: parsed };
    }

    return { ok: false, value };
  } catch (e) {
    return { ok: false, value };
  }
}
