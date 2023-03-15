// Create a logger class that uses the debug package internally

export type LogLevel = "log" | "error" | "warn" | "info" | "debug";

const logLevels: Array<LogLevel> = ["log", "error", "warn", "info", "debug"];

export class Logger {
  #name: string;
  readonly #level: number;
  #filteredKeys: string[] = [];

  constructor(
    name: string,
    level: LogLevel = "info",
    filteredKeys: string[] = []
  ) {
    this.#name = name;
    this.#level = logLevels.indexOf(
      (process.env.TRIGGER_LOG_LEVEL ?? level) as LogLevel
    );
    this.#filteredKeys = filteredKeys;
  }

  // Return a new Logger instance with the same name and a new log level
  // but filter out the keys from the log messages (at any level)
  filter(...keys: string[]) {
    return new Logger(this.#name, logLevels[this.#level], keys);
  }

  log(...args: any[]) {
    if (this.#level < 0) return;

    console.log(`[${formattedDateTime()}] [${this.#name}] `, ...args);
  }

  error(...args: any[]) {
    if (this.#level < 1) return;

    console.error(`[${formattedDateTime()}] [${this.#name}] `, ...args);
  }

  warn(...args: any[]) {
    if (this.#level < 2) return;

    console.warn(`[${formattedDateTime()}] [${this.#name}] `, ...args);
  }

  info(...args: any[]) {
    if (this.#level < 3) return;

    console.info(`[${formattedDateTime()}] [${this.#name}] `, ...args);
  }

  debug(message: string, ...args: Array<Record<string, unknown>>) {
    if (this.#level < 4) return;

    const structuredLog = {
      timestamp: formattedDateTime(),
      name: this.#name,
      message,
      args: structureArgs(args, this.#filteredKeys),
    };

    console.debug(JSON.stringify(structuredLog));
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

// If args is has a single item that is an object, return that object
function structureArgs(
  args: Array<Record<string, unknown>>,
  filteredKeys: string[] = []
) {
  if (args.length === 0) {
    return;
  }

  if (args.length === 1 && typeof args[0] === "object") {
    return filterKeys(JSON.parse(JSON.stringify(args[0])), filteredKeys);
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
      continue;
    }

    filteredObj[key] = filterKeys(value, keys);
  }

  return filteredObj;
}
