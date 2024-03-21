import { Config } from "@trigger.dev/core/v3";
import type { Plugin } from "esbuild";
import { logger } from "./logger";
import { createRequire } from "node:module";

export function bundleDependenciesPlugin(config: Config): Plugin {
  return {
    name: "bundle-dependencies",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind !== "import-statement") {
          return undefined;
        }

        for (let pattern of config.dependenciesToBundle ?? []) {
          // bundle it if the path matches the pattern
          if (typeof pattern === "string" ? args.path === pattern : pattern.test(args.path)) {
            try {
              const resolvedPath = resolvePath(args.path);

              logger.debug(`Bundling ${args.path} as ${resolvedPath}`);

              return {
                path: resolvedPath,
                external: false,
              };
            } catch (error) {
              logger.error(`Failed to resolve path ${args.path}`, error);

              return undefined;
            }
          }
        }

        return undefined;
      });
    },
  };
}

function resolvePath(path: string): string {
  try {
    logger.debug("[bundle-dependencies] Attempting to resolve path using ESM resolver", {
      path,
      importMetaUrl: import.meta.url,
    });

    return createRequire(import.meta.url).resolve(path);
  } catch (error) {
    logger.debug("[bundle-dependencies] Failed. Falling back to require.resolve", {
      path,
      error,
    });

    return require.resolve(path);
  }
}
