import * as esbuild from "esbuild";

export function bunPlugin(): esbuild.Plugin {
  return {
    name: "bun",
    setup(build) {
      build.onResolve({ filter: /^bun:/ }, (args) => {
        return { path: args.path, external: true };
      });
    },
  };
}
