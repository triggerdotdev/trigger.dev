import { BuildExtension } from "@trigger.dev/core/v3/build";
import { readFile } from "node:fs/promises";
import typescriptPkg from "typescript";

const { transpileModule, ModuleKind } = typescriptPkg;

const decoratorMatcher = new RegExp(/((?<![(\s]\s*['"])@\w[.[\]\w\d]*\s*(?![;])[((?=\s)])/);

export function emitDecoratorMetadata(): BuildExtension {
  return {
    name: "emitDecoratorMetadata",
    onBuildStart(context) {
      context.registerPlugin({
        name: "emitDecoratorMetadata",
        async setup(build) {
          const { parseNative, TSConfckCache } = await import("tsconfck");
          const cache = new TSConfckCache<any>();

          build.onLoad({ filter: /\.ts$/ }, async (args) => {
            context.logger.debug("emitDecoratorMetadata onLoad", { args });

            const { tsconfigFile, tsconfig } = await parseNative(args.path, {
              ignoreNodeModules: true,
              cache,
            });

            context.logger.debug("emitDecoratorMetadata parsed native tsconfig", {
              tsconfig,
              tsconfigFile,
              args,
            });

            if (tsconfig.compilerOptions?.emitDecoratorMetadata !== true) {
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
                ...tsconfig.compilerOptions,
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
