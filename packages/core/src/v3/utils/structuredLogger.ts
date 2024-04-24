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
}

export class SimpleStructuredLogger implements StructuredLogger {
  constructor(
    private name: string,
    private level: LogLevel = ["1", "true"].includes(process.env.DEBUG ?? "")
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

  #structuredLog(
    loggerFunction: (message: string, ...args: any[]) => void,
    message: string,
    level: string,
    ...args: StructuredArgs
  ) {
    const structuredLog = {
      ...(args.length === 1 ? args[0] : args),
      ...this.fields,
      timestamp: new Date(),
      name: this.name,
      message,
      level,
    };

    loggerFunction(JSON.stringify(structuredLog));
  }
}
