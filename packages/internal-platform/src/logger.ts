// Create a logger class that uses the debug package internally

export type LogLevel = "log" | "error" | "warn" | "info" | "debug";

const logLevels: Array<LogLevel> = ["log", "error", "warn", "info", "debug"];

export class Logger {
  #name: string;
  readonly #level: number;

  constructor(name: string, level: LogLevel = "info") {
    this.#name = name;
    this.#level = logLevels.indexOf(level);
  }

  log(...args: any[]) {
    if (this.#level > logLevels.indexOf("log")) return;

    console.log(`[${this.#name}] `, ...args);
  }

  error(...args: any[]) {
    if (this.#level > logLevels.indexOf("error")) return;

    console.error(`[${this.#name}] `, ...args);
  }

  warn(...args: any[]) {
    if (this.#level > logLevels.indexOf("warn")) return;

    console.warn(`[${this.#name}] `, ...args);
  }

  info(...args: any[]) {
    if (this.#level > logLevels.indexOf("info")) return;

    console.info(`[${this.#name}] `, ...args);
  }

  debug(...args: any[]) {
    if (this.#level > logLevels.indexOf("debug")) return;

    console.debug(`[${this.#name}] `, ...args);
  }
}
