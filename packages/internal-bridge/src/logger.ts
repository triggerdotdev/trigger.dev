// Create a logger class that uses the debug package internally

const logLevels = [
  "disabled",
  "log",
  "error",
  "warn",
  "info",
  "debug",
] as const;

export type LogLevel = (typeof logLevels)[number];

export class Logger {
  #name: string;
  readonly #level: number;

  constructor(name: string, level: LogLevel = "disabled") {
    this.#name = name;
    this.#level = logLevels.indexOf(
      (process.env.TRIGGER_LOG_LEVEL ?? level) as LogLevel
    );
  }

  log(...args: any[]) {
    if (this.#level < 1) return;

    console.log(`[${this.#name}] `, ...args);
  }

  error(...args: any[]) {
    if (this.#level < 2) return;

    console.error(`[${formattedDateTime()}] [${this.#name}] `, ...args);
  }

  warn(...args: any[]) {
    if (this.#level < 3) return;

    console.warn(`[${formattedDateTime()}] [${this.#name}] `, ...args);
  }

  info(...args: any[]) {
    if (this.#level < 4) return;

    console.info(`[${formattedDateTime()}] [${this.#name}] `, ...args);
  }

  debug(...args: any[]) {
    if (this.#level < 5) return;

    console.debug(`[${formattedDateTime()}] [${this.#name}] `, ...args);
  }
}

function formattedDateTime() {
  const date = new Date();

  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = date.getSeconds();
  const milliseconds = date.getMilliseconds();

  // Make sure the time is always 2 digits
  const formattedHours = hours < 10 ? `0${hours}` : hours;
  const formattedMinutes = minutes < 10 ? `0${minutes}` : minutes;
  const formattedSeconds = seconds < 10 ? `0${seconds}` : seconds;
  const formattedMilliseconds =
    milliseconds < 10
      ? `00${milliseconds}`
      : milliseconds < 100
      ? `0${milliseconds}`
      : milliseconds;

  return `${formattedHours}:${formattedMinutes}:${formattedSeconds}.${formattedMilliseconds}`;
}
