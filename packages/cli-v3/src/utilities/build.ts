import { ResolvedConfig } from "@trigger.dev/core/v3";
import type { Plugin } from "esbuild";
import { logger } from "./logger";
import { join } from "node:path";
import { createRequire } from "node:module";

export function bundleDependenciesPlugin(config: ResolvedConfig): Plugin {
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
              const resolvedPath = resolvePath(args.path, config);

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

function resolvePath(path: string, config: ResolvedConfig): string {
  const requireUrl = join(config.projectDir, "index.js");

  try {
    const tmpRequire = createRequire(requireUrl);

    logger.debug("[bundle-dependencies] Attempting to resolve path using require.resolve", {
      path,
      requireUrl,
    });

    return tmpRequire.resolve(path);
  } catch (e) {
    logger.debug(
      "[bundle-dependencies] Attempting to resolve path using ESM import.meta.url resolver",
      {
        path,
        importMetaUrl: import.meta.url,
      }
    );

    return require.resolve(path);
  }
}
