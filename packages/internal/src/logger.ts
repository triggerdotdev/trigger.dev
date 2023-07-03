// Create a logger class that uses the debug package internally

export type LogLevel = "log" | "error" | "warn" | "info" | "debug";

const logLevels: Array<LogLevel> = ["log", "error", "warn", "info", "debug"];

export class Logger {
  #name: string;
  readonly #level: number;
  #filteredKeys: string[] = [];
  #jsonReplacer?: (key: string, value: unknown) => unknown;

  constructor(
    name: string,
    level: LogLevel = "info",
    filteredKeys: string[] = [],
    jsonReplacer?: (key: string, value: unknown) => unknown
  ) {
    this.#name = name;
    this.#level = logLevels.indexOf(
      (process.env.TRIGGER_LOG_LEVEL ?? level) as LogLevel
    );
    this.#filteredKeys = filteredKeys;
    this.#jsonReplacer = jsonReplacer;
  }

  // Return a new Logger instance with the same name and a new log level
  // but filter out the keys from the log messages (at any level)
  filter(...keys: string[]) {
    return new Logger(
      this.#name,
      logLevels[this.#level],
      keys,
      this.#jsonReplacer
    );
  }

  static satisfiesLogLevel(logLevel: LogLevel, setLevel: LogLevel) {
    return logLevels.indexOf(logLevel) <= logLevels.indexOf(setLevel);
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

  debug(message: string, ...args: Array<Record<string, unknown> | undefined>) {
    if (this.#level < 4) return;

    const structuredLog = {
      timestamp: new Date(),
      name: this.#name,
      message,
      args: structureArgs(
        safeJsonClone(args) as Record<string, unknown>[],
        this.#filteredKeys
      ),
    };

    console.debug(
      JSON.stringify(structuredLog, createReplacer(this.#jsonReplacer))
    );
  }
}

function createReplacer(replacer?: (key: string, value: unknown) => unknown) {
  return (key: string, value: unknown) => {
    if (typeof value === "bigint") {
      return value.toString();
    }

    if (replacer) {
      return replacer(key, value);
    }

    return value;
  };
}

// Replacer function for JSON.stringify that converts BigInts to strings
function bigIntReplacer(_key: string, value: unknown) {
  if (typeof value === "bigint") {
    return value.toString();
  }

  return value;
}

function safeJsonClone(obj: unknown) {
  try {
    return JSON.parse(JSON.stringify(obj, bigIntReplacer));
  } catch (e) {
    return obj;
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
    return filterKeys(
      JSON.parse(JSON.stringify(args[0], bigIntReplacer)),
      filteredKeys
    );
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
