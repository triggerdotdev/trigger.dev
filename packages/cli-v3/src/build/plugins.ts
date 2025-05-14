import * as esbuild from "esbuild";
import { BuildTarget } from "@trigger.dev/core/v3/schemas";
import { ResolvedConfig } from "@trigger.dev/core/v3/build";
import { configPlugin } from "../config.js";
import { logger } from "../utilities/logger.js";
import { resolvePathSync as esmResolveSync } from "mlly";
import { readPackageJSON, resolvePackageJSON } from "pkg-types";
import { dirname } from "node:path";
import { readJSONFile } from "../utilities/fileSystem.js";

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

export class SdkVersionExtractor {
  private _sdkVersion: string | undefined;
  private _ranOnce = false;

  get sdkVersion() {
    return this._sdkVersion;
  }

  get plugin(): esbuild.Plugin {
    return {
      name: "sdk-version",
      setup: (build) => {
        build.onResolve({ filter: /^@trigger\.dev\/sdk\// }, async (args) => {
          if (this._ranOnce) {
            return undefined;
          } else {
            this._ranOnce = true;
          }

          logger.debug("[SdkVersionExtractor] Extracting SDK version", { args });

          try {
            const resolvedPath = esmResolveSync(args.path, {
              url: args.resolveDir,
            });

            logger.debug("[SdkVersionExtractor] Resolved SDK module path", { resolvedPath });

            const packageJsonPath = await resolvePackageJSON(dirname(resolvedPath), {
              test: async (filePath) => {
                try {
                  const candidate = await readJSONFile(filePath);

                  // Exclude esm type markers
                  return Object.keys(candidate).length > 1 || !candidate.type;
                } catch (error) {
                  logger.debug("[SdkVersionExtractor] Error during package.json test", {
                    error: error instanceof Error ? error.message : error,
                  });

                  return false;
                }
              },
            });

            if (!packageJsonPath) {
              return undefined;
            }

            logger.debug("[SdkVersionExtractor] Found package.json", { packageJsonPath });

            const packageJson = await readPackageJSON(packageJsonPath);

            if (!packageJson.name || packageJson.name !== "@trigger.dev/sdk") {
              logger.debug("[SdkVersionExtractor] No match for SDK package name", {
                packageJsonPath,
                packageJson,
              });

              return undefined;
            }

            if (!packageJson.version) {
              logger.debug("[SdkVersionExtractor] No version found in package.json", {
                packageJsonPath,
                packageJson,
              });

              return undefined;
            }

            this._sdkVersion = packageJson.version;

            logger.debug("[SdkVersionExtractor] Found SDK version", {
              args,
              packageJsonPath,
              sdkVersion: this._sdkVersion,
            });

            return undefined;
          } catch (error) {
            logger.debug("[SdkVersionExtractor] Failed to extract SDK version", { error });
          }

          return undefined;
        });
      },
    };
  }
}
