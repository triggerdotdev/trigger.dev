import { LogLevel } from "../logger/taskLogger";
import { RetryOptions } from "../schemas";
import type { InstrumentationOption } from "@opentelemetry/instrumentation";

export interface ProjectConfig {
  project: string;
  triggerDirectories?: string | string[];
  triggerUrl?: string;
  retries?: {
    enabledInDev?: boolean;
    default?: RetryOptions;
  };
  additionalPackages?: string[];

  /**
   * List of additional files to include in your trigger.dev bundle. e.g. ["./prisma/schema.prisma"]
   *
   * Supports glob patterns.
   */
  additionalFiles?: string[];
  /**
   * List of patterns that determine if a module is included in your trigger.dev bundle. This is needed when consuming ESM only packages, since the trigger.dev bundle is currently built as a CJS module.
   */
  dependenciesToBundle?: Array<string | RegExp>;

  /**
   * The path to your project's tsconfig.json file. Will use tsconfig.json in the project directory if not provided.
   */
  tsconfigPath?: string;

  /**
   * The OpenTelemetry instrumentations to enable
   */
  instrumentations?: InstrumentationOption[];

  /**
   * Set the log level for the logger. Defaults to "log", so you will see "log", "warn", and "error" messages, but not "info", or "debug" messages.
   *
   * We automatically set the logLevel to "debug" during test runs
   *
   * @default "log"
   */
  logLevel?: LogLevel;

  /**
   * Enable console logging while running the dev CLI. This will print out logs from console.log, console.warn, and console.error. By default all logs are sent to the trigger.dev backend, and not logged to the console.
   */
  enableConsoleLogging?: boolean;
}
