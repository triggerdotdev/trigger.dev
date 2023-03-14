// Create a logger class that uses the debug package internally

const logLevels = [
  "disabled",
  "error",
  "log",
  "warn",
  "info",
  "debug",
] as const;

export type LogLevel = (typeof logLevels)[number];

export class Logger {
  #name: string;
  #tags: string[];
  readonly #level: number;

  constructor(name: string | string[], level: LogLevel = "log") {
    if (typeof name === "string") {
      this.#name = name;
      this.#tags = [];
    } else {
      const [n, ...tags] = name;

      this.#name = n;
      this.#tags = tags;
    }

    this.#level = logLevels.indexOf(
      (process.env.TRIGGER_LOG_LEVEL ?? level) as LogLevel
    );
  }

  log(...args: any[]) {
    if (this.#level < 1) return;

    console.log(`${this.#formatName()} `, ...[...args, ...this.#formatTags()]);
  }

  logClean(...args: any[]) {
    if (this.#level < 1) return;

    console.log(`${this.#formatName()} `, ...args);
  }

  error(...args: any[]) {
    if (this.#level < 2) return;

    console.error(
      `[${formattedDateTime()}] ${this.#formatName()} `,
      ...[...args, ...this.#formatTags()]
    );
  }

  warn(...args: any[]) {
    if (this.#level < 3) return;

    console.warn(
      `[${formattedDateTime()}] ${this.#formatName()} `,
      ...[...args, ...this.#formatTags()]
    );
  }

  info(...args: any[]) {
    if (this.#level < 4) return;

    console.info(
      `[${formattedDateTime()}] ${this.#formatName()} `,
      ...[...args, ...this.#formatTags()]
    );
  }

  debug(message: string, ...args: any[]) {
    if (this.#level < 5) return;

    const structuredLog = {
      timestamp: formattedDateTime(),
      name: this.#name,
      tags: this.#tags,
      message,
      args: structureArgs(args),
    };

    console.debug(JSON.stringify(structuredLog));
  }

  #formatName() {
    if (Array.isArray(this.#name)) {
      return this.#name.map((name) => `[${name}]`).join("");
    }

    return `[${this.#name}]`;
  }

  #formatTags() {
    return this.#tags.map((tag) => `[${tag}]`);
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
function structureArgs(args: any[]) {
  if (args.length === 0) {
    return;
  }

  if (args.length === 1 && typeof args[0] === "object") {
    return args[0];
  }

  return args;
}
