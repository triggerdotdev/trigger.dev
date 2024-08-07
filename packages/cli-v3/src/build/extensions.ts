import * as esbuild from "esbuild";
import { resolveModule } from "./resolveModule.js";
import { BuildContext, BuildExtension, BuildLayer, RegisteredPlugin, RegisterPluginOptions, ResolvedConfig } from "@trigger.dev/core/v3/build";
import { BuildManifest, BuildTarget } from "@trigger.dev/core/v3/schemas";
import { logger } from "../utilities/logger.js";

export function createExtensionForPlugin(
  plugin: esbuild.Plugin,
  options: RegisterPluginOptions = {}
): BuildExtension {
  return {
    name: plugin.name,
    onBuildStart(context) {
      context.registerPlugin(plugin, options);
    },
  };
}

export interface InternalBuildContext extends BuildContext {
  getLayers(): BuildLayer[];
  clearLayers(): void;
  getPlugins(): RegisteredPlugin[];
  appendExtension(extension: BuildExtension): void;
  prependExtension(extension: BuildExtension): void;
  getExtensions(): BuildExtension[];
}

export async function notifyExtensionOnBuildStart(
  context: InternalBuildContext
) {
  for (const extension of context.getExtensions()) {
    if (extension.onBuildStart) {
      await extension.onBuildStart(context);
    }
  }
}

export async function notifyExtensionOnBuildComplete(
  context: InternalBuildContext,
  manifest: BuildManifest
): Promise<BuildManifest> {
  let $manifest = manifest;

  for (const extension of context.getExtensions()) {
    if (extension.onBuildComplete) {
      await extension.onBuildComplete(context, $manifest);
      logger.debug(`Applying extension ${extension.name} to manifest`, {
        context,
        manifest,
      });
      $manifest = applyContextLayersToManifest(context, $manifest);
    }
  }

  return $manifest;
}

export function createBuildContext(
  target: BuildTarget,
  config: ResolvedConfig
): InternalBuildContext {
  const layers: BuildLayer[] = [];
  const registeredPlugins: RegisteredPlugin[] = [];
  const extensions: BuildExtension[] = config.build.extensions ?? [];

  return {
    target,
    config: config,
    workingDir: config.workingDir,
    addLayer(layer) {
      layers.push(layer);
    },
    getLayers() {
      return layers;
    },
    clearLayers() {
      layers.splice(0);
    },
    registerPlugin(plugin, options) {
      if (options?.target && options.target !== target) {
        return;
      }

      registeredPlugins.push({ plugin, ...options });
    },
    getPlugins() {
      return registeredPlugins;
    },
    resolvePath: async (path) => {
      try {
        return await resolveModule(path, config.workingDir);
      } catch (error) {
        return undefined;
      }
    },
    getExtensions() {
      return extensions;
    },
    appendExtension(extension) {
      extensions.push(extension);
    },
    prependExtension(extension) {
      extensions.unshift(extension);
    },
  };
}

function applyContextLayersToManifest(
  context: InternalBuildContext,
  manifest: BuildManifest
): BuildManifest {
  for (const layer of context.getLayers()) {
    manifest = applyLayerToManifest(layer, manifest);
  }

  context.clearLayers();

  return manifest;
}

function applyLayerToManifest(
  layer: BuildLayer,
  manifest: BuildManifest
): BuildManifest {
  let $manifest = { ...manifest };

  if (layer.commands) {
    manifest.build.commands ??= [];
    manifest.build.commands = manifest.build.commands.concat(layer.commands);
  }

  if (layer.build?.env) {
    manifest.build.env ??= {};
    Object.assign(manifest.build.env, layer.build.env);
  }

  if (layer.deploy?.env) {
    manifest.deploy.env ??= {};
    Object.assign(manifest.deploy.env, layer.deploy.env);
  }

  if (layer.dependencies) {
    const externals = manifest.externals ?? [];

    for (const [name, version] of Object.entries(layer.dependencies)) {
      externals.push({ name, version });
    }

    $manifest.externals = externals;
  }

  return $manifest;
}

export function resolvePluginsForContext(
  context: InternalBuildContext
): esbuild.Plugin[] {
  const registeredPlugins = context.getPlugins();

  if (registeredPlugins.length === 0) {
    return [];
  }

  const sortedPlugins = [...registeredPlugins].sort((a, b) => {
    const order = { first: 0, undefined: 1, last: 2, $head: -1 };
    const aOrder = order[a.placement as keyof typeof order] ?? 1;
    const bOrder = order[b.placement as keyof typeof order] ?? 1;

    // If the placement order is different, sort based on that
    if (aOrder !== bOrder) {
      return aOrder - bOrder;
    }

    // If the placement order is the same, maintain original order
    return registeredPlugins.indexOf(a) - registeredPlugins.indexOf(b);
  });

  return sortedPlugins.map((plugin) => plugin.plugin);
}
