import { BuildExtension, createExtensionForPlugin } from "@trigger.dev/core/v3/build";
import type { Plugin } from "esbuild";
import { readFile } from "node:fs/promises";
import { readTSConfig } from "pkg-types";
import typescriptPkg from "typescript";

const { transpileModule, ModuleKind } = typescriptPkg;

const decoratorMatcher = new RegExp(/((?<![(\s]\s*['"])@\w[.[\]\w\d]*\s*(?![;])[((?=\s)])/);

export type EmitDecoratorMetadataOptions = {
  path?: string;
};

export function emitDecoratorMetadata(options: EmitDecoratorMetadataOptions = {}): BuildExtension {
  return createExtensionForPlugin(plugin(options));
}

function plugin(options: EmitDecoratorMetadataOptions = {}): Plugin {
  return {
    name: "emitDecoratorMetadata",
    async setup(build) {
      const tsconfig = await readTSConfig(options.path);

      if (!tsconfig) {
        return;
      }

      if (!tsconfig.compilerOptions?.emitDecoratorMetadata) {
        console.warn(
          "Typescript decorators plugin requires `emitDecoratorMetadata` to be set to true in your tsconfig.json"
        );

        return;
      }

      build.onLoad({ filter: /\.ts$/ }, async (args) => {
        const ts = await readFile(args.path, "utf8");

        if (!ts) return;

        // Find the decorator and if there isn't one, return out
        if (!decoratorMatcher.test(ts)) {
          return;
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
  };
}
