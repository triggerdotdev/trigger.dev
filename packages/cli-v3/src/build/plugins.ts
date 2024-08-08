import * as esbuild from "esbuild";
import { BuildTarget } from "@trigger.dev/core/v3/schemas";
import { ResolvedConfig } from "@trigger.dev/core/v3/build";
import { configPlugin } from "../config.js";
import { logger } from "../utilities/logger.js";

export async function buildPlugins(
  target: BuildTarget,
  resolvedConfig: ResolvedConfig
): Promise<esbuild.Plugin[]> {
  logger.debug("Building plugins for target", target);

  const plugins: esbuild.Plugin[] = [];

  const $configPlugin = configPlugin(resolvedConfig);

  if ($configPlugin) {
    plugins.push($configPlugin);
  }

  plugins.push(mockServerOnlyPlugin());

  return plugins;
}

export function analyzeMetadataPlugin(): esbuild.Plugin {
  return {
    name: "analyze-metafile",
    setup(build) {
      build.onEnd(async (result) => {
        if (!result.metafile) {
          return;
        }

        console.log(
          await esbuild.analyzeMetafile(result.metafile, {
            verbose: true,
          })
        );
      });
    },
  };
}

export function mockServerOnlyPlugin(): esbuild.Plugin {
  return {
    name: "trigger-mock-server-only",
    setup(build) {
      build.onResolve({ filter: /^server-only$/ }, (args) => {
        if (args.path !== "server-only") {
          return undefined;
        }

        logger.debug(`[trigger-mock-server-only] Bundling ${args.path}`, {
          ...args,
        });

        return {
          path: args.path,
          external: false,
          namespace: "server-only-mock",
        };
      });

      build.onLoad({ filter: /^server-only$/, namespace: "server-only-mock" }, (args) => {
        return {
          contents: `export default true;`,
          loader: "js",
        };
      });
    },
  };
}
