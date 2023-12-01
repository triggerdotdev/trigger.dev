import { defineConfig } from "tsup";
import { Plugin } from "esbuild";

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

export default defineConfig([
  {
    name: "main",
    config: "tsconfig.build.json",
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
    esbuildPlugins: [restoreNodeProtocolPlugin()],
  },
]);
