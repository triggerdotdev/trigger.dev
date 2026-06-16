import { dirname } from "node:path";
import { BuildExtension } from "@trigger.dev/core/v3/build";
import { readFile } from "node:fs/promises";
import typescriptPkg from "typescript";

const { transpileModule, ModuleKind, findConfigFile, readConfigFile, parseJsonConfigFileContent, sys } = typescriptPkg;

const decoratorMatcher = new RegExp(/((?<![(\s]\s*['"])@\w[.[\]\w\d]*\s*(?![;])[((?=\s)])/);

export function emitDecoratorMetadata(): BuildExtension {
  return {
    name: "emitDecoratorMetadata",
    onBuildStart(context) {
      context.registerPlugin({
        name: "emitDecoratorMetadata",
        async setup(build) {
          const configCache = new Map<string, any>();

          build.onLoad({ filter: /\.ts$/ }, async (args) => {
            context.logger.debug("emitDecoratorMetadata onLoad", { args });

            const searchPath = dirname(args.path);
            const tsconfigFile = findConfigFile(searchPath, sys.fileExists, "tsconfig.json");

            context.logger.debug("emitDecoratorMetadata resolved tsconfig file", {
              tsconfigFile,
              args,
            });

            let compilerOptions: any = {};

            if (tsconfigFile) {
              if (configCache.has(tsconfigFile)) {
                compilerOptions = configCache.get(tsconfigFile);
              } else {
                const configFile = readConfigFile(tsconfigFile, sys.readFile);
                if (configFile.config) {
                  const parsedConfig = parseJsonConfigFileContent(
                    configFile.config,
                    sys,
                    dirname(tsconfigFile)
                  );
                  compilerOptions = parsedConfig.options || {};
                }
                configCache.set(tsconfigFile, compilerOptions);
              }
            }

            if (compilerOptions.emitDecoratorMetadata !== true) {
              context.logger.debug("emitDecoratorMetadata skipping", {
                args,
                compilerOptions,
              });

              return undefined;
            }

            const ts = await readFile(args.path, "utf8");

            if (!ts) return undefined;

            // Find the decorator and if there isn't one, return out
            if (!decoratorMatcher.test(ts)) {
              context.logger.debug("emitDecoratorMetadata skipping, no decorators found", {
                args,
              });

              return undefined;
            }

            const program = transpileModule(ts, {
              fileName: args.path,
              compilerOptions: {
                ...compilerOptions,
                module: ModuleKind.ES2022,
              },
            });

            return { contents: program.outputText };
          });
        },
      });
    },
  };
}

