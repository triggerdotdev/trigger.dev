import { BuildExtension } from "@trigger.dev/core/v3/build";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { loadTypescript } from "./internal/loadTypescript.js";

const decoratorMatcher = new RegExp(/((?<![(\s]\s*['"])@\w[.[\]\w\d]*\s*(?![;])[((?=\s)])/);

export function emitDecoratorMetadata(): BuildExtension {
  return {
    name: "emitDecoratorMetadata",
    onBuildStart(context) {
      const { convertCompilerOptionsFromJson, transpileModule, ModuleKind } = loadTypescript(
        context.workingDir
      );

      context.registerPlugin({
        name: "emitDecoratorMetadata",
        async setup(build) {
          const { parse, TSConfckCache } = await import("tsconfck");
          const cache = new TSConfckCache<any>();

          build.onLoad({ filter: /\.ts$/ }, async (args) => {
            context.logger.debug("emitDecoratorMetadata onLoad", { args });

            const { tsconfigFile, tsconfig } = await parse(args.path, {
              ignoreNodeModules: true,
              cache,
            });
            const { options: compilerOptions } = convertCompilerOptionsFromJson(
              tsconfig.compilerOptions ?? {},
              tsconfigFile ? dirname(tsconfigFile) : context.workingDir
            );

            context.logger.debug("emitDecoratorMetadata parsed tsconfig", {
              tsconfig,
              tsconfigFile,
              args,
            });

            if (compilerOptions.emitDecoratorMetadata !== true) {
              context.logger.debug("emitDecoratorMetadata skipping", {
                args,
                tsconfig,
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
