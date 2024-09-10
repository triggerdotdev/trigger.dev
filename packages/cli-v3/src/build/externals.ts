import * as esbuild from "esbuild";
import { makeRe } from "minimatch";
import { mkdir, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readPackageJSON, resolvePackageJSON } from "pkg-types";
import nodeResolve from "resolve";
import { getInstrumentedPackageNames } from "./instrumentation.js";
import { BuildTarget } from "@trigger.dev/core/v3/schemas";
import {
  alwaysExternal,
  BuildExtension,
  BuildLogger,
  ResolvedConfig,
} from "@trigger.dev/core/v3/build";
import { logger } from "../utilities/logger.js";
import { CliApiClient } from "../apiClient.js";

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
    const resolvedPath = nodeResolve.sync(external.name, {
      basedir: resolveDir,
    });

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

  return {
    externals,
    plugin: {
      name: "externals",
      setup: (build) => {
        build.onStart(async () => {
          externals.splice(0);
        });

        build.onEnd(async () => {
          logger.debug("[externals][onEnd] Collected externals", { externals });
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
              const resolvedPath = nodeResolve.sync(packageName, {
                basedir: args.resolveDir,
              });

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

  for (const externalName of getInstrumentedPackageNames(config)) {
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
