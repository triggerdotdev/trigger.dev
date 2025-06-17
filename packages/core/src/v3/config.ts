import type { Instrumentation } from "@opentelemetry/instrumentation";
import type { SpanExporter } from "@opentelemetry/sdk-trace-base";
import type { BuildExtension } from "./build/extensions.js";
import type {
  AnyOnFailureHookFunction,
  AnyOnInitHookFunction,
  AnyOnStartHookFunction,
  AnyOnSuccessHookFunction,
  BuildRuntime,
  RetryOptions,
} from "./index.js";
import type { LogLevel } from "./logger/taskLogger.js";
import type { MachinePresetName } from "./schemas/common.js";
import { LogRecordExporter } from "@opentelemetry/sdk-logs";

export type CompatibilityFlag = "run_engine_v2";

export type CompatibilityFlagFeatures = {
  [key in CompatibilityFlag]: boolean;
};

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

    /**
     * Log exporters to use for OpenTelemetry. This is useful if you want to add custom log exporters to your tasks.
     *
     * @see https://trigger.dev/docs/config/config-file#exporters
     */
    logExporters?: Array<LogRecordExporter>;
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
  compatibilityFlags?: Array<CompatibilityFlag>;

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

  /**
   * Disable the console interceptor. This will prevent logs from being sent to the trigger.dev backend.
   */
  disableConsoleInterceptor?: boolean;

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

    /**
     * **WARNING: This is an experimental feature and might be removed in a future version.**
     *
     * Automatically detect dependencies that shouldn't be bundled and mark them as external. For example, native modules.
     *
     * Turning this on will not affect dependencies that were manually added to the `external` array.
     *
     * @default false
     *
     * @deprecated (experimental)
     */
    experimental_autoDetectExternal?: boolean;

    /**
     * **WARNING: This is an experimental feature and might be removed in a future version.**
     *
     * Preserve the original names of functions and classes in the bundle. This can fix issues with frameworks that rely on the original names for registration and binding, for example MikroORM.
     *
     * @link https://esbuild.github.io/api/#keep-names
     *
     * @default false
     *
     * @deprecated (experimental)
     */
    experimental_keepNames?: boolean;

    /**
     * **WARNING: This is an experimental feature and might be removed in a future version.**
     *
     * "Minification is not safe for 100% of all JavaScript code" - esbuild docs
     *
     * Minify the generated code to help decrease bundle size. This may break stuff.
     *
     * @link https://esbuild.github.io/api/#minify
     *
     * @default false
     *
     * @deprecated (experimental)
     */
    experimental_minify?: boolean;

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
   * @default false
   * @description Keep the process alive after the task has finished running so the next task doesn't have to wait for the process to start up again.
   *
   * Note that the process could be killed at any time, and we don't make any guarantees about the process being alive for a certain amount of time
   */
  experimental_processKeepAlive?: boolean;

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
   *
   * @deprecated, please use tasks.init instead
   */
  init?: AnyOnInitHookFunction;

  /**
   * onSuccess is called after the run function has successfully completed.
   *
   * @deprecated, please use tasks.onSuccess instead
   */
  onSuccess?: AnyOnSuccessHookFunction;

  /**
   * onFailure is called after a task run has failed (meaning the run function threw an error and won't be retried anymore)
   *
   * @deprecated, please use tasks.onFailure instead
   */
  onFailure?: AnyOnFailureHookFunction;

  /**
   * onStart is called the first time a task is executed in a run (not before every retry)
   *
   * @deprecated, please use tasks.onStart instead
   */
  onStart?: AnyOnStartHookFunction;

  /**
   * @deprecated Use a custom build extension to add post install commands
   */
  postInstall?: string;
};
