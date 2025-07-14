import { Attributes, Span, SpanOptions } from "@opentelemetry/api";
import { Logger, SeverityNumber } from "@opentelemetry/api-logs";
import { iconStringForSeverity } from "../icons.js";
import { SemanticInternalAttributes } from "../semanticInternalAttributes.js";
import { TriggerTracer } from "../tracer.js";
import { flattenAttributes } from "../utils/flattenAttributes.js";
import { ClockTime } from "../clock/clock.js";
import { clock } from "../clock-api.js";
import { Prettify } from "../types/utils.js";

export type LogLevel = "none" | "error" | "warn" | "info" | "debug" | "log";

export const logLevels: Array<LogLevel> = ["none", "error", "warn", "info", "debug"];

export type TaskLoggerConfig = {
  logger: Logger;
  tracer: TriggerTracer;
  level: LogLevel;
  maxAttributeCount?: number;
};

export type TraceOptions = Prettify<
  SpanOptions & {
    icon?: string;
  }
>;

export interface TaskLogger {
  debug(message: string, properties?: Record<string, unknown>): void;
  log(message: string, properties?: Record<string, unknown>): void;
  info(message: string, properties?: Record<string, unknown>): void;
  warn(message: string, properties?: Record<string, unknown>): void;
  error(message: string, properties?: Record<string, unknown>): void;
  trace<T>(name: string, fn: (span: Span) => Promise<T>, options?: TraceOptions): Promise<T>;
  startSpan(name: string, options?: TraceOptions): Span;
}

export class OtelTaskLogger implements TaskLogger {
  private readonly _level: number;

  constructor(private readonly _config: TaskLoggerConfig) {
    this._level = logLevels.indexOf(_config.level);
  }

  debug(message: string, properties?: Record<string, unknown>) {
    if (this._level < 4) return; // ["none", "error", "warn", "info", "debug"];

    this.#emitLog(message, this.#getTimestampInHrTime(), "debug", SeverityNumber.DEBUG, properties);
  }

  log(message: string, properties?: Record<string, unknown>) {
    if (this._level < 3) return; // ["none", "error", "warn", "info", "debug"];

    this.#emitLog(message, this.#getTimestampInHrTime(), "log", SeverityNumber.INFO, properties);
  }

  info(message: string, properties?: Record<string, unknown>) {
    if (this._level < 3) return; // ["none", "error", "warn", "info", "debug"];

    this.#emitLog(message, this.#getTimestampInHrTime(), "info", SeverityNumber.INFO, properties);
  }

  warn(message: string, properties?: Record<string, unknown>) {
    if (this._level < 2) return; // ["none", "error", "warn", "info", "debug"];

    this.#emitLog(message, this.#getTimestampInHrTime(), "warn", SeverityNumber.WARN, properties);
  }

  error(message: string, properties?: Record<string, unknown>) {
    if (this._level < 1) return; // ["none", "error", "warn", "info", "debug"];

    this.#emitLog(message, this.#getTimestampInHrTime(), "error", SeverityNumber.ERROR, properties);
  }

  #emitLog(
    message: string,
    timestamp: ClockTime,
    severityText: string,
    severityNumber: SeverityNumber,
    properties?: Record<string, unknown>
  ) {
    let attributes: Attributes = {};

    if (properties) {
      // Use flattenAttributes directly - it now handles all non-JSON friendly values efficiently
      attributes = flattenAttributes(properties, undefined, this._config.maxAttributeCount);
    }

    const icon = iconStringForSeverity(severityNumber);
    if (icon !== undefined) {
      attributes[SemanticInternalAttributes.STYLE_ICON] = icon;
    }

    this._config.logger.emit({
      severityNumber,
      severityText,
      body: message,
      attributes,
      timestamp,
    });
  }

  trace<T>(name: string, fn: (span: Span) => Promise<T>, options?: TraceOptions): Promise<T> {
    const spanOptions = {
      ...options,
      attributes: {
        ...options?.attributes,
        [SemanticInternalAttributes.STYLE_ICON]: options?.icon ?? "trace",
      },
    };

    return this._config.tracer.startActiveSpan(name, fn, spanOptions);
  }

  startSpan(name: string, options?: TraceOptions): Span {
    const spanOptions = {
      ...options,
      attributes: {
        ...options?.attributes,
        ...(options?.icon ? { [SemanticInternalAttributes.STYLE_ICON]: options.icon } : {}),
      },
    };

    return this._config.tracer.startSpan(name, spanOptions);
  }

  #getTimestampInHrTime(): ClockTime {
    return clock.preciseNow();
  }
}

export class NoopTaskLogger implements TaskLogger {
  debug() {}
  log() {}
  info() {}
  warn() {}
  error() {}
  trace<T>(name: string, fn: (span: Span) => Promise<T>): Promise<T> {
    return fn({} as Span);
  }
  startSpan(): Span {
    return {} as Span;
  }
}
