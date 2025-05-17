type StructuredArgs = (Record<string, unknown> | undefined)[];

export interface StructuredLogger {
  log: (message: string, ...args: StructuredArgs) => any;
  error: (message: string, ...args: StructuredArgs) => any;
  warn: (message: string, ...args: StructuredArgs) => any;
  info: (message: string, ...args: StructuredArgs) => any;
  debug: (message: string, ...args: StructuredArgs) => any;
  child: (fields: Record<string, unknown>) => StructuredLogger;
}

export enum LogLevel {
  "log",
  "error",
  "warn",
  "info",
  "debug",
  "verbose",
}

export class SimpleStructuredLogger implements StructuredLogger {
  private prettyPrint = ["1", "true"].includes(process.env.PRETTY_LOGS ?? "");

  constructor(
    private name: string,
    private level: LogLevel = ["1", "true"].includes(process.env.VERBOSE ?? "")
      ? LogLevel.verbose
      : ["1", "true"].includes(process.env.DEBUG ?? "")
      ? LogLevel.debug
      : LogLevel.info,
    private fields?: Record<string, unknown>
  ) {}

  child(fields: Record<string, unknown>, level?: LogLevel) {
    return new SimpleStructuredLogger(this.name, level, { ...this.fields, ...fields });
  }

  log(message: string, ...args: StructuredArgs) {
    if (this.level < LogLevel.log) return;

    this.#structuredLog(console.log, message, "log", ...args);
  }

  error(message: string, ...args: StructuredArgs) {
    if (this.level < LogLevel.error) return;

    this.#structuredLog(console.error, message, "error", ...args);
  }

  warn(message: string, ...args: StructuredArgs) {
    if (this.level < LogLevel.warn) return;

    this.#structuredLog(console.warn, message, "warn", ...args);
  }

  info(message: string, ...args: StructuredArgs) {
    if (this.level < LogLevel.info) return;

    this.#structuredLog(console.info, message, "info", ...args);
  }

  debug(message: string, ...args: StructuredArgs) {
    if (this.level < LogLevel.debug) return;

    this.#structuredLog(console.debug, message, "debug", ...args);
  }

  verbose(message: string, ...args: StructuredArgs) {
    if (this.level < LogLevel.verbose) return;

    this.#structuredLog(console.debug, message, "verbose", ...args);
  }

  addFields(fields: Record<string, unknown>) {
    this.fields = {
      ...this.fields,
      ...fields,
    };
  }

  #structuredLog(
    loggerFunction: (message: string, ...args: any[]) => void,
    message: string,
    level: string,
    ...args: StructuredArgs
  ) {
    const structuredLog = {
      timestamp: new Date(),
      message,
      $name: this.name,
      $level: level,
      ...this.fields,
      ...(args.length === 1 ? args[0] : args),
    };

    if (this.prettyPrint) {
      loggerFunction(JSON.stringify(structuredLog, null, 2));
    } else {
      loggerFunction(JSON.stringify(structuredLog));
    }
  }
}
