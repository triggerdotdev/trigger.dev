import { Config } from "@trigger.dev/core/v3";
import type { Plugin } from "esbuild";
import { logger } from "./logger";

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
            const resolvedPath = require.resolve(args.path);

            logger.debug(`Bundling ${args.path} as ${resolvedPath}`);

            return {
              path: resolvedPath,
              external: false,
            };
          }
        }

        return undefined;
      });
    },
  };
}
