import { Plugin } from "esbuild";
import { Options, defineConfig as defineConfigTSUP } from "tsup";

const restoreNodeProtocolPlugin = (): Plugin => {
  return {
    name: "node-protocol-plugin-restorer",
    setup(build) {
      build.onResolve(
        {
          filter: /node:/,
        },
        async (args) => {
          return { path: args.path, external: true };
        }
      );
    },
  };
};

export const options: Options = {
  name: "main",
  config: "tsconfig.json",
  entry: ["./src/index.ts"],
  outDir: "./dist",
  platform: "node",
  format: ["cjs", "esm"],
  legacyOutput: false,
  sourcemap: true,
  clean: true,
  bundle: true,
  splitting: false,
  dts: true,
  treeshake: {
    preset: "recommended",
  },
  esbuildPlugins: [restoreNodeProtocolPlugin()],
};

export const defineConfig = defineConfigTSUP(options);
