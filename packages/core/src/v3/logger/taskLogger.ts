import { Logger, SeverityNumber } from "@opentelemetry/api-logs";
import { flattenAttributes } from "../utils/flattenAttributes";

export type LogLevel = "log" | "error" | "warn" | "info" | "debug";

const logLevels: Array<LogLevel> = ["error", "warn", "log", "info", "debug"];

export type TaskLoggerConfig = {
  logger: Logger;
  level: LogLevel;
};

export interface TaskLogger {
  debug(message: string, properties?: Record<string, unknown>): void;
  log(message: string, properties?: Record<string, unknown>): void;
  info(message: string, properties?: Record<string, unknown>): void;
  warn(message: string, properties?: Record<string, unknown>): void;
  error(message: string, properties?: Record<string, unknown>): void;
}

export class OtelTaskLogger implements TaskLogger {
  private readonly _level: number;

  constructor(private readonly _config: TaskLoggerConfig) {
    this._level = logLevels.indexOf(_config.level);
  }

  debug(message: string, properties?: Record<string, unknown>) {
    if (this._level < 4) return;

    this.#emitLog(message, "debug", SeverityNumber.DEBUG, properties);
  }

  log(message: string, properties?: Record<string, unknown>) {
    if (this._level < 2) return;

    this.#emitLog(message, "log", SeverityNumber.INFO, properties);
  }

  info(message: string, properties?: Record<string, unknown>) {
    if (this._level < 3) return;

    this.#emitLog(message, "info", SeverityNumber.INFO, properties);
  }

  warn(message: string, properties?: Record<string, unknown>) {
    if (this._level < 1) return;

    this.#emitLog(message, "warn", SeverityNumber.WARN, properties);
  }

  error(message: string, properties?: Record<string, unknown>) {
    if (this._level < 0) return;

    this.#emitLog(message, "error", SeverityNumber.ERROR, properties);
  }

  #emitLog(
    message: string,
    severityText: string,
    severityNumber: SeverityNumber,
    properties?: Record<string, unknown>
  ) {
    this._config.logger.emit({
      severityNumber,
      severityText,
      body: message,
      attributes: { ...flattenAttributes(properties), "log.type": "logger" },
    });
  }
}

export class NoopTaskLogger implements TaskLogger {
  debug() {}
  log() {}
  info() {}
  warn() {}
  error() {}
}
