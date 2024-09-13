// Barrel no more
export type {
  BuildContext,
  BuildExtension,
  BuildLayer,
  BuildLogger,
  BuildSpinner,
  RegisteredPlugin,
  RegisterPluginOptions,
  PluginPlacement,
  ResolvedConfig,
} from "@trigger.dev/core/v3/build";

export type { BuildManifest, WorkerManifest } from "@trigger.dev/core/v3/schemas";

export { binaryForRuntime, esbuildPlugin } from "@trigger.dev/core/v3/build";
