import { BuildManifest, BuildTarget } from "../schemas/build.js";
import type { Plugin } from "esbuild";
import { ResolvedConfig } from "./resolvedConfig.js";

export function esbuildPlugin(plugin: Plugin, options: RegisterPluginOptions = {}): BuildExtension {
  return {
    name: plugin.name,
    onBuildStart(context) {
      context.registerPlugin(plugin, options);
    },
  };
}

export interface BuildExtension {
  name: string;
  externalsForTarget?: (target: BuildTarget) => string[] | undefined;
  onBuildStart?: (context: BuildContext) => Promise<void> | void;
  onBuildComplete?: (
    context: BuildContext,
    manifest: BuildManifest
  ) => Promise<undefined | void> | undefined | void;
}

export interface BuildSpinner {
  stop: (message: string, code?: number) => void;
  message: (message: string) => void;
}

export interface BuildLogger {
  debug: (...args: unknown[]) => void;
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  progress: (message: string) => void;
  spinner: (message: string) => BuildSpinner;
}

export interface BuildContext {
  target: BuildTarget;
  config: ResolvedConfig;
  workingDir: string;
  logger: BuildLogger;

  addLayer(layer: BuildLayer): void;
  registerPlugin(plugin: Plugin, options?: RegisterPluginOptions): void;

  /*
   * Resolve a path relative to the working directory
   */
  resolvePath(path: string): Promise<string | undefined>;
}

export interface BuildLayer {
  id: string;
  commands?: string[];
  files?: Record<string, string>;
  image?: {
    pkgs?: string[];
    instructions?: string[];
  };
  build?: {
    env?: Record<string, string | undefined>;
  };
  deploy?: {
    env?: Record<string, string | undefined>;
    parentEnv?: Record<string, string | undefined>;
    override?: boolean;
  };
  dependencies?: Record<string, string>;
  conditions?: string[];
}

export type PluginPlacement = "first" | "last";

export type RegisterPluginOptions = {
  target?: BuildTarget;
  placement?: PluginPlacement;
};

export type RegisteredPlugin = RegisterPluginOptions & {
  plugin: Plugin;
};
