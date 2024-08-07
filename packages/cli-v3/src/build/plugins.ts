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
