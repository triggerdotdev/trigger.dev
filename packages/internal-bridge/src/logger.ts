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
    if (this.#level < 0) return;

    console.log(`[${this.#name}] `, ...args);
  }

  error(...args: any[]) {
    if (this.#level < 1) return;

    console.error(`[${this.#name}] `, ...args);
  }

  warn(...args: any[]) {
    if (this.#level < 2) return;

    console.warn(`[${this.#name}] `, ...args);
  }

  info(...args: any[]) {
    if (this.#level < 3) return;

    console.info(`[${this.#name}] `, ...args);
  }

  debug(...args: any[]) {
    if (this.#level < 4) return;

    console.debug(`[${this.#name}] `, ...args);
  }
}
