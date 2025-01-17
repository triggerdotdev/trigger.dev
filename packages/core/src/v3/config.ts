import type { Instrumentation } from "@opentelemetry/instrumentation";
import type { SpanExporter } from "@opentelemetry/sdk-trace-base";
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
   * @default "node"
   */
  runtime?: BuildRuntime;

  /**
   * Specify the project ref for your trigger.dev tasks. This is the project ref that you get when you create a new project in the trigger.dev dashboard.
   */
  project: string;

  /**
   * Specify the directories that contain your trigger.dev tasks. This is useful if you have multiple directories that contain tasks.
   *
   * We automatically detect directories named `trigger` to be task directories. You can override this behavior by specifying the directories here.
   *
   * @see @see https://trigger.dev/docs/config/config-file#dirs
   */
  dirs?: string[];

  /**
   * Specify glob patterns to ignore when detecting task files. By default we ignore:
   *
   * - *.test.ts
   * - *.spec.ts
   * - *.test.mts
   * - *.spec.mts
   * - *.test.cts
   * - *.spec.cts
   * - *.test.js
   * - *.spec.js
   * - *.test.mjs
   * - *.spec.mjs
   * - *.test.cjs
   * - *.spec.cjs
   *
   */
  ignorePatterns?: string[];

  /**
   * Instrumentations to use for OpenTelemetry. This is useful if you want to add custom instrumentations to your tasks.
   *
   * @see https://trigger.dev/docs/config/config-file#instrumentations
   *
   * @deprecated Use the `telemetry.instrumentations` option instead.
   */
  instrumentations?: Array<Instrumentation>;

  telemetry?: {
    /**
     * Instrumentations to use for OpenTelemetry. This is useful if you want to add custom instrumentations to your tasks.
     *
     * @see https://trigger.dev/docs/config/config-file#instrumentations
     */
    instrumentations?: Array<Instrumentation>;

    /**
     * Exporters to use for OpenTelemetry. This is useful if you want to add custom exporters to your tasks.
     *
     * @see https://trigger.dev/docs/config/config-file#exporters
     */
    exporters?: Array<SpanExporter>;
  };

  /**
   * Specify a custom path to your tsconfig file. This is useful if you have a custom tsconfig file that you want to use.
   */
  tsconfig?: string;

  /**
   * Specify the global retry options for your tasks. You can override this on a per-task basis.
   *
   * @see https://trigger.dev/docs/tasks/overview#retry-options
   */
  retries?: {
    enabledInDev?: boolean;
    default?: RetryOptions;
  };

  /**
   * The default machine preset to use for your deployed trigger.dev tasks. You can override this on a per-task basis.
   * @default "small-1x"
   *
   * @see https://trigger.dev/docs/machines
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
   * The maximum duration in compute-time seconds that a task run is allowed to run. If the task run exceeds this duration, it will be stopped.
   *
   * Minimum value is 5 seconds
   *
   * Setting this value will effect all tasks in the project.
   *
   * @see https://trigger.dev/docs/tasks/overview#maxduration-option
   */
  maxDuration: number;

  /**
   * Enable console logging while running the dev CLI. This will print out logs from console.log, console.warn, and console.error. By default all logs are sent to the trigger.dev backend, and not logged to the console.
   */
  enableConsoleLogging?: boolean;

  build?: {
    /**
     * Add custom conditions to the esbuild build. For example, if you are importing `ai/rsc`, you'll need to add "react-server" condition.
     *
     * By default we add the following conditions:
     *
     * - "trigger.dev"
     * - "module"
     * - "node"
     */
    conditions?: string[];

    /**
     * Add custom build extensions to the build process.
     *
     * @see https://trigger.dev/docs/config/config-file#extensions
     */
    extensions?: BuildExtension[];

    /**
     * External dependencies to exclude from the bundle. This is useful if you want to keep some dependencies as external, and not bundle them with your code.
     *
     * @see https://trigger.dev/docs/config/config-file#external
     */
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
