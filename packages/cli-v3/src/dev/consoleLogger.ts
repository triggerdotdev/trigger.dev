import type * as logsAPI from "@opentelemetry/api-logs";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { taskContextManager } from "@trigger.dev/core/v3";
import util from "node:util";

export class ConsoleLogger {
  constructor(private readonly logger: logsAPI.Logger) {}

  // Intercept the console and send logs to the OpenTelemetry logger
  // during the execution of the callback
  async intercept<T, R extends Promise<T>>(console: Console, callback: () => R): Promise<T> {
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
    this.logger.emit({
      severityNumber,
      severityText,
      body: util.format(...args),
      attributes: this.#getAttributes(),
    });
  }

  #getAttributes(): logsAPI.LogAttributes {
    return {
      "log.type": "LogRecord",
      ...taskContextManager.attributes,
    };
  }
}
