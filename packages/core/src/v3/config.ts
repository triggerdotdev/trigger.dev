import type { Instrumentation } from "@opentelemetry/instrumentation";
import type { BuildExtension } from "./build/extensions.js";
import type { MachinePresetName } from "./schemas/common.js";
import type { LogLevel } from "./logger/taskLogger.js";
import type {
  FailureFnParams,
  InitFnParams,
  StartFnParams,
  SuccessFnParams,
} from "./types/index.js";
import type { BuildRuntime, RetryOptions } from "./index.js";

export type TriggerConfig = {
  /**
   * @default "node20"
   */
  runtime?: BuildRuntime;
  project: string;
  dirs?: string[];
  instrumentations?: Array<Instrumentation>;
  tsconfig?: string;
  retries?: {
    enabledInDev?: boolean;
    default?: RetryOptions;
  };
  /**
   * The default machine preset to use for your deployed trigger.dev tasks. You can override this on a per-task basis.
   * @default "small-1x"
   */
  machine?: MachinePresetName;
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
  build?: {
    extensions?: BuildExtension[];
    external?: string[];
    jsx?: {
      /**
       * @default "React.createElement"
       */
      factory?: string;
      /**
       * @default "React.Fragment"
       */
      fragment?: string;

      /**
       * @default true
       * @description Set the esbuild jsx option to automatic. Set this to false if you aren't using React.
       * @see https://esbuild.github.io/api/#jsx
       */
      automatic?: boolean;
    };
  };
  deploy?: {
    env?: Record<string, string>;
  };

  /**
   * @deprecated Use `dirs` instead
   */
  triggerDirectories?: string[];

  /**
   * @deprecated Use the `additionalPackages` extension instead.
   */
  additionalPackages?: string[];

  /**
   * @deprecated Use the `additionalFiles` extension instead.
   */
  additionalFiles?: string[];

  /**
   * @deprecated Dependencies are now bundled by default. If you want to exclude some dependencies from the bundle, use the `build.external` option.
   */
  dependenciesToBundle?: Array<string | RegExp>;

  /**
   * @deprecated Use `tsconfig` instead.
   */
  tsconfigPath?: string;

  /**
   * CA Cert file to be added to NODE_EXTRA_CA_CERT environment variable in, useful in use with self signed cert in the trigger.dev environment.
   *
   * @example "./certs/ca.crt"
   * Note: must start with "./" and be relative to the project root.
   *
   */
  extraCACerts?: string;

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
   * @deprecated Use a custom build extension to add post install commands
   */
  postInstall?: string;
};
