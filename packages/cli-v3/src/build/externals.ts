import * as esbuild from "esbuild";
import { makeRe } from "minimatch";
import { mkdir, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readPackageJSON, resolvePackageJSON } from "pkg-types";
import nodeResolve from "resolve";
import { getInstrumentedPackageNames } from "./instrumentation.js";
import { BuildTarget } from "@trigger.dev/core/v3/schemas";
import { BuildExtension, ResolvedConfig } from "@trigger.dev/core/v3/build";
import { logger } from "../utilities/logger.js";

const FORCED_EXTERNALS = ["import-in-the-middle"];

/**
 * externals in dev might not be resolvable from the worker directory
 * for example, if the external is not an immediate dependency of the project
 * and the project is not hoisting the dependency (e.g. pnpm, npm with nested)
 *
 * This function will create a symbolic link from a place where the external is resolvable
 * to the actual resolved external path
 */
async function linkUnresolvableExternals(externals: Array<CollectedExternal>, resolveDir: string) {
  for (const external of externals) {
    if (!(await isExternalResolvable(external, resolveDir))) {
      logger.debug("External is not resolvable", { external });
      await linkExternal(external, resolveDir);
    }
  }
}

async function linkExternal(external: CollectedExternal, resolveDir: string) {
  const destinationPath = join(resolveDir, "node_modules");
  await mkdir(destinationPath, { recursive: true });

  logger.debug("Make a symbolic link", {
    fromPath: external.path,
    destinationPath,
    external,
  });
  await symlink(external.path, join(destinationPath, external.name), "dir");
}

async function isExternalResolvable(external: CollectedExternal, resolveDir: string) {
  try {
    const resolvedPath = nodeResolve.sync(external.name, {
      basedir: resolveDir,
    });

    logger.debug("Resolved external", {
      external,
      resolvedPath,
    });

    return true;
  } catch (e) {
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
  resolvedConfig: ResolvedConfig
): ExternalsCollector {
  const externals: Array<CollectedExternal> = [];

  const maybeExternals = discoverMaybeExternals(target, resolvedConfig);

  logger.debug("Maybe externals", { maybeExternals });

  return {
    externals,
    plugin: {
      name: "externals",
      setup: (build) => {
        build.onStart(async () => {
          externals.splice(0);
        });

        build.onEnd(async () => {
          logger.debug("Collected externals", { externals });
        });

        maybeExternals.forEach((external) => {
          build.onResolve({ filter: external.filter, namespace: "file" }, async (args) => {
            const resolvedPath = nodeResolve.sync(args.path, {
              basedir: args.resolveDir,
            });

            logger.debug("Resolved external", {
              external,
              resolvedPath,
              args,
            });

            const packageJsonPath = await resolvePackageJSON(dirname(resolvedPath));

            if (!packageJsonPath) {
              return undefined;
            }

            logger.debug("Found package.json", { packageJsonPath });

            const packageJson = await readPackageJSON(packageJsonPath);

            if (!packageJson || !packageJson.name) {
              return undefined;
            }

            if (!external.filter.test(packageJson.name)) {
              logger.debug("Package name does not match", {
                external,
                packageJson,
              });

              return undefined;
            }

            if (!packageJson.version) {
              logger.debug("No version found in package.json", {
                external,
                packageJson,
              });

              return undefined;
            }

            externals.push({
              name: packageJson.name,
              path: dirname(packageJsonPath),
              version: packageJson.version,
            });

            logger.debug("Resolved external", {
              external,
              resolvedPath,
              args,
            });

            return {
              external: true,
            };
          });
        });
      },
    },
  };
}

type MaybeExternal = { raw: string; filter: RegExp };

function discoverMaybeExternals(target: BuildTarget, config: ResolvedConfig): Array<MaybeExternal> {
  const external: Array<MaybeExternal> = [];

  for (const externalName of FORCED_EXTERNALS) {
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
      const externalRegex = makeRe(externalName);

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
    const externalRegex = makeRe(externalName);

    if (!externalRegex) {
      continue;
    }

    external.push({
      raw: externalName,
      filter: new RegExp(`^${externalName}$|${externalRegex.source}`),
    });
  }

  for (const buildExtension of config.build?.extensions ?? []) {
    const moduleExternals = buildExtension.externalsForTarget?.(target);

    for (const externalName of moduleExternals ?? []) {
      const externalRegex = makeRe(externalName);

      if (!externalRegex) {
        continue;
      }

      external.push({
        raw: externalName,
        filter: new RegExp(`^${externalName}$|${externalRegex.source}`),
      });
    }
  }

  return external;
}

export function createExternalsBuildExtension(
  target: BuildTarget,
  config: ResolvedConfig
): BuildExtension {
  const { externals, plugin } = createExternalsCollector(target, config);

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
        await linkUnresolvableExternals(externals, manifest.outputPath);
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
