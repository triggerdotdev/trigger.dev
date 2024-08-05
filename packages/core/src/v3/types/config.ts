import { FailureFnParams, InitFnParams, StartFnParams, SuccessFnParams } from "./index.js";
import { LogLevel } from "../logger/taskLogger.js";
import { MachinePresetName, RetryOptions } from "../schemas/index.js";
import type { Instrumentation } from "@opentelemetry/instrumentation";

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
   * The default machine preset to use for your deployed trigger.dev tasks. You can override this on a per-task basis.
   * @default "small-1x"
   */
  machine?: MachinePresetName;

  /**
   * List of additional files to include in your trigger.dev bundle. e.g. ["./prisma/schema.prisma"]
   *
   * Supports glob patterns.
   *
   * Note: The path separator for glob patterns is `/`, even on Windows!
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
  instrumentations?: Instrumentation[];

  /**
   * Set the log level for the logger. Defaults to "info", so you will see "log", "info", "warn", and "error" messages, but not "debug" messages.
   *
   * We automatically set the logLevel to "debug" during test runs
   *
   * @default "info"
   */
  logLevel?: LogLevel;

  /**
   * Enable console logging while running the dev CLI. This will print out logs from console.log, console.warn, and console.error. By default all logs are sent to the trigger.dev backend, and not logged to the console.
   */
  enableConsoleLogging?: boolean;

  /**
   * Run before a task is executed, for all tasks. This is useful for setting up any global state that is needed for all tasks.
   */
  init?: (payload: unknown, params: InitFnParams) => void | Promise<void>;

  /**
   * onSuccess is called after the run function has successfully completed.
   */
  onSuccess?: (payload: unknown, output: unknown, params: SuccessFnParams<any>) => Promise<void>;

  /**
   * onFailure is called after a task run has failed (meaning the run function threw an error and won't be retried anymore)
   */
  onFailure?: (payload: unknown, error: unknown, params: FailureFnParams<any>) => Promise<void>;

  /**
   * onStart is called the first time a task is executed in a run (not before every retry)
   */
  onStart?: (payload: unknown, params: StartFnParams) => Promise<void>;

  /**
   * postInstall will run during the deploy build step, after all the dependencies have been installed.
   *
   * @example "prisma generate"
   */
  postInstall?: string;

  /**
   * CA Cert file to be added to NODE_EXTRA_CA_CERT environment variable in, useful in use with self signed cert in the trigger.dev environment.
   *
   * @example "./certs/ca.crt"
   * Note: must start with "./" and be relative to the project root.
   *
   */
  extraCACerts?: string;
}
