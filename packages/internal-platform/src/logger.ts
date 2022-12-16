// Create a logger class that uses the debug package internally

export type LogLevel = "log" | "error" | "warn" | "info" | "debug";

const logLevels: Array<LogLevel> = ["log", "error", "warn", "info", "debug"];

export class Logger {
  #name: string;
  readonly #level: number;

  constructor(name: string, level: LogLevel = "info") {
    this.#name = name;

    // First use the LOG_LEVEL environment variable to set the log level
    // If that's not set, use the level argument
    const logLevel = process.env.LOG_LEVEL || level;

    this.#level = logLevels.indexOf(logLevel as LogLevel);
  }

  log(...args: any[]) {
    if (this.#level < logLevels.indexOf("log")) return;

    console.log(`[${this.#name}] `, ...args);
  }

  error(...args: any[]) {
    if (this.#level < logLevels.indexOf("error")) return;

    console.error(`[${this.#name}] `, ...args);
  }

  warn(...args: any[]) {
    if (this.#level < logLevels.indexOf("warn")) return;

    console.warn(`[${this.#name}] `, ...args);
  }

  info(...args: any[]) {
    if (this.#level < logLevels.indexOf("info")) return;

    console.info(`[${this.#name}] `, ...args);
  }

  debug(...args: any[]) {
    if (this.#level < logLevels.indexOf("debug")) return;

    console.debug(`[${this.#name}] `, ...args);
  }
}
