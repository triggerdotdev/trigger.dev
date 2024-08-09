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

  plugins.push(polyshedPlugin());

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

const polysheds = [
  {
    moduleName: "server-only",
    code: "export default true;",
  },
];

export function polyshedPlugin(): esbuild.Plugin {
  return {
    name: "polyshed",
    setup(build) {
      for (const polyshed of polysheds) {
        build.onResolve({ filter: new RegExp(`^${polyshed.moduleName}$`) }, (args) => {
          if (args.path !== polyshed.moduleName) {
            return undefined;
          }

          return {
            path: args.path,
            external: false,
            namespace: `polyshed-${polyshed.moduleName}`,
          };
        });

        build.onLoad(
          {
            filter: new RegExp(`^${polyshed.moduleName}$`),
            namespace: `polyshed-${polyshed.moduleName}`,
          },
          (args) => {
            return {
              contents: polyshed.code,
              loader: "js",
            };
          }
        );
      }
    },
  };
}
