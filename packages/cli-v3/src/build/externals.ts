import * as esbuild from "esbuild";
import { makeRe } from "minimatch";
import { access, mkdir, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readPackageJSON, resolvePackageJSON } from "pkg-types";
import nodeResolve from "resolve";
import { BuildTarget } from "@trigger.dev/core/v3/schemas";
import {
  alwaysExternal,
  BuildExtension,
  BuildLogger,
  ResolvedConfig,
} from "@trigger.dev/core/v3/build";
import { logger } from "../utilities/logger.js";
import { CliApiClient } from "../apiClient.js";
import { resolvePathSync as esmResolveSync } from "mlly";
import braces from "braces";
import { builtinModules } from "node:module";
import { tryCatch } from "@trigger.dev/core/v3";
import { resolveModule } from "./resolveModule.js";

/**
 * externals in dev might not be resolvable from the worker directory
 * for example, if the external is not an immediate dependency of the project
 * and the project is not hoisting the dependency (e.g. pnpm, npm with nested)
 *
 * This function will create a symbolic link from a place where the external is resolvable
 * to the actual resolved external path
 */
async function linkUnresolvableExternals(
  externals: Array<CollectedExternal>,
  resolveDir: string,
  logger: BuildLogger
) {
  for (const external of externals) {
    if (!(await isExternalResolvable(external, resolveDir, logger))) {
      await linkExternal(external, resolveDir, logger);
    }
  }
}

async function linkExternal(external: CollectedExternal, resolveDir: string, logger: BuildLogger) {
  const destinationPath = join(resolveDir, "node_modules");
  await mkdir(destinationPath, { recursive: true });

  logger.debug("[externals] Make a symbolic link", {
    fromPath: external.path,
    destinationPath,
    external,
  });

  // For scoped packages, we need to ensure the scope directory exists
  if (external.name.startsWith("@")) {
    // Get the scope part (e.g., '@huggingface')
    const scopeDir = external.name.split("/")[0];

    if (scopeDir) {
      const scopePath = join(destinationPath, scopeDir);

      logger.debug("[externals] Ensure scope directory exists", {
        scopeDir,
        scopePath,
      });

      await mkdir(scopePath, { recursive: true });
    } else {
      logger.debug("[externals] Unable to get the scope directory", {
        external,
      });
    }
  }

  const symbolicLinkPath = join(destinationPath, external.name);

  // Make sure the symbolic link does not exist
  try {
    await symlink(external.path, symbolicLinkPath, "dir");
  } catch (e) {
    logger.debug("[externals] Unable to create symbolic link", {
      error: e,
      fromPath: external.path,
      destinationPath,
      external,
    });
  }
}

async function isExternalResolvable(
  external: CollectedExternal,
  resolveDir: string,
  logger: BuildLogger
) {
  try {
    const resolvedPath = resolveSync(external.name, resolveDir);

    logger.debug("[externals][isExternalResolvable] Resolved external", {
      resolveDir,
      external,
      resolvedPath,
    });

    if (!resolvedPath.includes(external.path)) {
      logger.debug(
        "[externals][isExternalResolvable] resolvedPath does not match the external.path",
        {
          resolveDir,
          external,
          resolvedPath,
        }
      );

      return false;
    }

    return true;
  } catch (e) {
    logger.debug("[externals][isExternalResolvable] Unable to resolve external", {
      resolveDir,
      external,
      error: e,
    });

    return false;
  }
}

export type CollectedExternal = {
  name: string;
  path: string;
  version: string;
};

export type ExternalsCollector = {
  externals: Array<CollectedExternal>;
  plugin: esbuild.Plugin;
};

function createExternalsCollector(
  target: BuildTarget,
  resolvedConfig: ResolvedConfig,
  forcedExternal: string[] = []
): ExternalsCollector {
  const externals: Array<CollectedExternal> = [];

  const maybeExternals = discoverMaybeExternals(target, resolvedConfig, forcedExternal);

  // Cache: resolvedPath (dir) -> packageJsonPath (null = failed to resolve)
  const packageJsonCache = new Map<string, string | null>();
  // Cache: packageRoot (dir) -> boolean (true = mark as external)
  const isExternalCache = new Map<string, boolean>();

  return {
    externals,
    plugin: {
      name: "externals",
      setup: (build) => {
        build.onStart(async () => {
          externals.splice(0);
          isExternalCache.clear();
        });

        build.onEnd(async () => {
          logger.debug("[externals][onEnd] Collected externals", {
            externals,
            maybeExternals,
            autoDetectExternal: !!resolvedConfig.build?.autoDetectExternal,
            packageJsonCache: packageJsonCache.size,
            isExternalCache: isExternalCache.size,
          });
        });

        maybeExternals.forEach((external) => {
          build.onResolve({ filter: external.filter, namespace: "file" }, async (args) => {
            // Check if the external is already in the externals collection
            if (externals.find((e) => e.name === external.raw)) {
              return {
                external: true,
              };
            }

            const packageName = packageNameForImportPath(args.path);

            try {
              const resolvedPath = resolveSync(packageName, args.resolveDir);

              logger.debug("[externals][onResolve] Resolved external", {
                external,
                resolvedPath,
                args,
                packageName,
              });

              const packageJsonPath = await resolvePackageJSON(dirname(resolvedPath));

              if (!packageJsonPath) {
                return undefined;
              }

              logger.debug("[externals][onResolve] Found package.json", {
                packageJsonPath,
                external,
                resolvedPath,
                args,
                packageName,
              });

              const packageJson = await readPackageJSON(packageJsonPath);

              if (!packageJson || !packageJson.name) {
                return undefined;
              }

              if (!external.filter.test(packageJson.name)) {
                logger.debug("[externals][onResolve] Package name does not match", {
                  external,
                  packageJson,
                  resolvedPath,
                  packageName,
                });

                return undefined;
              }

              if (!packageJson.version) {
                logger.debug("[externals][onResolve] No version found in package.json", {
                  external,
                  packageJson,
                  resolvedPath,
                });

                return undefined;
              }

              externals.push({
                name: packageName,
                path: dirname(packageJsonPath),
                version: packageJson.version,
              });

              logger.debug("[externals][onResolve] adding external to the externals collection", {
                external,
                resolvedPath,
                args,
                packageName,
                resolvedExternal: {
                  name: packageJson.name,
                  path: dirname(packageJsonPath),
                  version: packageJson.version,
                },
              });

              return {
                external: true,
              };
            } catch (error) {
              logger.debug("[externals][onResolve] Unable to resolve external", {
                external,
                error,
                args,
                packageName,
              });

              return undefined;
            }
          });
        });

        if (resolvedConfig.build?.autoDetectExternal) {
          build.onResolve(
            { filter: /.*/, namespace: "file" },
            async (args: esbuild.OnResolveArgs): Promise<esbuild.OnResolveResult | undefined> => {
              if (!isBareModuleImport(args.path)) {
                // Not an npm package
                return;
              }

              if (isBuiltinModule(args.path)) {
                // Builtin module
                return;
              }

              // Try to resolve the actual file path
              const [resolveError, resolvedPath] = await tryCatch(
                resolveModule(args.path, args.resolveDir)
              );

              if (resolveError) {
                logger.debug("[externals][auto] Resolve module error", {
                  path: args.path,
                  resolveError,
                });
                return;
              }

              // Find nearest package.json
              const packageJsonPath = await findNearestPackageJson(resolvedPath, packageJsonCache);

              if (!packageJsonPath) {
                logger.debug("[externals][auto] Failed to resolve package.json path", {
                  path: args.path,
                  resolvedPath,
                });
                return;
              }

              const packageRoot = dirname(packageJsonPath);

              // Check cache first
              if (isExternalCache.has(packageRoot)) {
                const isExternal = isExternalCache.get(packageRoot);

                if (isExternal) {
                  return { path: args.path, external: true };
                }

                return;
              }

              const [readError, packageJson] = await tryCatch(readPackageJSON(packageRoot));

              if (readError) {
                logger.debug("[externals][auto] Unable to read package.json", {
                  error: readError,
                  packageRoot,
                });

                isExternalCache.set(packageRoot, false);
                return;
              }

              const packageName = packageJson.name;
              const packageVersion = packageJson.version;

              if (!packageName || !packageVersion) {
                logger.debug("[externals][auto] No package name or version found in package.json", {
                  packageRoot,
                  packageJson,
                });

                return;
              }

              const markExternal = (reason: string): esbuild.OnResolveResult => {
                const detectedPackage = {
                  name: packageName,
                  path: packageRoot,
                  version: packageVersion,
                } satisfies CollectedExternal;

                logger.debug(`[externals][auto] Marking as external - ${reason}`, {
                  detectedPackage,
                });

                externals.push(detectedPackage);

                // Cache the result
                isExternalCache.set(packageRoot, true);

                return { path: args.path, external: true };
              };

              // If the path ends with .wasm or .node, we should mark it as external
              if (resolvedPath.endsWith(".wasm") || resolvedPath.endsWith(".node")) {
                return markExternal("path ends with .wasm or .node");
              }

              // Check files, main, module fields for native files
              const files = Array.isArray(packageJson.files) ? packageJson.files : [];
              const fields = [packageJson.main, packageJson.module, packageJson.browser].filter(
                (f): f is string => typeof f === "string"
              );
              const allFiles = files.concat(fields);

              // We need to expand any braces in the files array, e.g. ["{js,ts}"] -> ["js", "ts"]
              const allFilesExpanded = braces(allFiles, { expand: true });

              // Use a regexp to match native-related extensions
              const nativeExtRegexp = /\.(wasm|node|gyp|c|cc|cpp|cxx|h|hpp|hxx)$/;
              const hasNativeFile = allFilesExpanded.some((file) => nativeExtRegexp.test(file));

              if (hasNativeFile) {
                return markExternal("has native file");
              }

              // Check if binding.gyp exists (native addon)
              const bindingGypPath = join(packageRoot, "binding.gyp");

              // If access succeeds, binding.gyp exists
              const [accessError] = await tryCatch(access(bindingGypPath));

              if (!accessError) {
                return markExternal("binding.gyp exists");
              }

              // Cache the negative result
              isExternalCache.set(packageRoot, false);

              return undefined;
            }
          );
        }
      },
    },
  };
}

type MaybeExternal = { raw: string; filter: RegExp };

function discoverMaybeExternals(
  target: BuildTarget,
  config: ResolvedConfig,
  forcedExternal: string[] = []
): Array<MaybeExternal> {
  const external: Array<MaybeExternal> = [];

  for (const externalName of forcedExternal) {
    const externalRegex = makeRe(externalName);

    if (!externalRegex) {
      continue;
    }

    external.push({
      raw: externalName,
      filter: new RegExp(`^${externalName}$|${externalRegex.source}`),
    });
  }

  if (config.build?.external) {
    for (const externalName of config.build?.external) {
      const externalRegex = makeExternalRegexp(externalName);

      if (!externalRegex) {
        continue;
      }

      external.push({
        raw: externalName,
        filter: externalRegex,
      });
    }
  }

  for (const externalName of config.instrumentedPackageNames ?? []) {
    const externalRegex = makeExternalRegexp(externalName);

    if (!externalRegex) {
      continue;
    }

    external.push({
      raw: externalName,
      filter: externalRegex,
    });
  }

  for (const buildExtension of config.build?.extensions ?? []) {
    const moduleExternals = buildExtension.externalsForTarget?.(target);

    for (const externalName of moduleExternals ?? []) {
      const externalRegex = makeExternalRegexp(externalName);

      if (!externalRegex) {
        continue;
      }

      external.push({
        raw: externalName,
        filter: externalRegex,
      });
    }
  }

  return external;
}

export function createExternalsBuildExtension(
  target: BuildTarget,
  config: ResolvedConfig,
  forcedExternal: string[] = []
): BuildExtension {
  const { externals, plugin } = createExternalsCollector(target, config, forcedExternal);

  return {
    name: "externals",
    onBuildStart(context) {
      context.registerPlugin(plugin, {
        target,
        // @ts-expect-error
        placement: "$head", // cheat to get to the front of the plugins
      });
    },
    onBuildComplete: async (context, manifest) => {
      if (context.target === "dev") {
        await linkUnresolvableExternals(externals, manifest.outputPath, context.logger);
      }

      context.addLayer({
        id: "externals",
        dependencies: externals.reduce(
          (acc, external) => {
            acc[external.name] = external.version;
            return acc;
          },
          {} as Record<string, string>
        ),
      });
    },
  };
}

function makeExternalRegexp(packageName: string): RegExp {
  // Escape special regex characters in the package name
  const escapedPkg = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Create the regex pattern
  const pattern = `^${escapedPkg}(?:/[^'"]*)?$`;

  return new RegExp(pattern);
}

function packageNameForImportPath(importPath: string): string {
  // Remove any leading '@' to handle it separately
  const withoutAtSign = importPath.replace(/^@/, "");

  // Split the path by '/'
  const parts = withoutAtSign.split("/");

  // Handle scoped packages
  if (importPath.startsWith("@")) {
    // Return '@org/package' for scoped packages
    return "@" + parts.slice(0, 2).join("/");
  } else {
    // Return just the first part for non-scoped packages
    return parts[0] as string;
  }
}

export async function resolveAlwaysExternal(client: CliApiClient): Promise<string[]> {
  try {
    const response = await client.retrieveExternals();

    if (response.success) {
      return response.data.externals;
    }

    return alwaysExternal;
  } catch (error) {
    logger.debug("[externals][resolveAlwaysExternal] Unable to retrieve externals", {
      error,
    });

    return alwaysExternal;
  }
}

function resolveSync(id: string, resolveDir: string) {
  try {
    return nodeResolve.sync(id, { basedir: resolveDir });
  } catch (error) {
    return esmResolveSync(id, { url: resolveDir });
  }
}

function isBareModuleImport(path: string): boolean {
  const excludes = [".", "/", "~", "file:", "data:"];
  return !excludes.some((exclude) => path.startsWith(exclude));
}

function isBuiltinModule(path: string): boolean {
  return builtinModules.includes(path.replace("node:", ""));
}

async function hasNoEsmTypeMarkers(filePath: string): Promise<boolean> {
  try {
    const packageJson = await readPackageJSON(filePath);

    // Exclude esm type markers. They look like this: { "type": "module" }
    return Object.keys(packageJson).length > 1 || !packageJson.type;
  } catch (error) {
    if (!(error instanceof Error)) {
      logger.debug("[externals][containsEsmTypeMarkers] Unknown error", {
        error,
      });

      return false;
    }

    if ("code" in error && error.code !== "ENOENT") {
      logger.debug("[externals][containsEsmTypeMarkers] Error", {
        error: error.message,
      });
    }

    return false;
  }
}

async function findNearestPackageJson(
  basePath: string,
  cache: Map<string, string | null>
): Promise<string | null> {
  const baseDir = dirname(basePath);

  if (cache.has(baseDir)) {
    const resolvedPath = cache.get(baseDir);

    if (!resolvedPath) {
      return null;
    }

    return resolvedPath;
  }

  const [error, packageJsonPath] = await tryCatch(
    resolvePackageJSON(dirname(basePath), {
      test: hasNoEsmTypeMarkers,
    })
  );

  if (error) {
    cache.set(baseDir, null);
    return null;
  }

  cache.set(baseDir, packageJsonPath);
  return packageJsonPath;
}
