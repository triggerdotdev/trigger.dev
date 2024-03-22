import type * as logsAPI from "@opentelemetry/api-logs";
import { SeverityNumber } from "@opentelemetry/api-logs";
import util from "node:util";
import { iconStringForSeverity } from "./icons";
import { SemanticInternalAttributes } from "./semanticInternalAttributes";
import { flattenAttributes } from "./utils/flattenAttributes";
import { type PreciseDateOrigin, calculatePreciseDateHrTime } from "./utils/preciseDate";


export class ConsoleInterceptor {
  constructor(private readonly logger: logsAPI.Logger, private readonly preciseDateOrigin: PreciseDateOrigin) { }

  // Intercept the console and send logs to the OpenTelemetry logger
  // during the execution of the callback
  async intercept<T>(console: Console, callback: () => Promise<T>): Promise<T> {
    // Save the original console methods
    const originalConsole = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
    };

    // Override the console methods
    console.log = this.log.bind(this);
    console.info = this.info.bind(this);
    console.warn = this.warn.bind(this);
    console.error = this.error.bind(this);

    try {
      return await callback();
    } finally {
      // Restore the original console methods
      console.log = originalConsole.log;
      console.info = originalConsole.info;
      console.warn = originalConsole.warn;
      console.error = originalConsole.error;
    }
  }

  log(...args: unknown[]): void {
    this.#handleLog(SeverityNumber.INFO, "Log", ...args);
  }

  info(...args: unknown[]): void {
    this.#handleLog(SeverityNumber.INFO, "Info", ...args);
  }

  warn(...args: unknown[]): void {
    this.#handleLog(SeverityNumber.WARN, "Warn", ...args);
  }

  error(...args: unknown[]): void {
    this.#handleLog(SeverityNumber.ERROR, "Error", ...args);
  }

  #handleLog(severityNumber: SeverityNumber, severityText: string, ...args: unknown[]): void {
    const body = util.format(...args);
    const timestamp = this.#getTimestampInHrTime();

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

  #getTimestampInHrTime(): [number, number] {
    return calculatePreciseDateHrTime(this.preciseDateOrigin);
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
