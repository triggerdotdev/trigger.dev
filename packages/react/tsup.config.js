import { defineConfig } from "tsup";
import { esbuildPluginFilePathExtensions } from "esbuild-plugin-file-path-extensions";

export default defineConfig([
  {
    entry: ["src/*.ts", "src/*.tsx"],
    format: ["cjs", "esm"],
    target: ["chrome91", "firefox90", "edge91", "safari15", "ios15", "opera77"],
    outDir: "build/modern",
    dts: true,
    sourcemap: true,
    clean: true,
    noExternal: ["@trigger.dev/internal"],
    esbuildPlugins: [esbuildPluginFilePathExtensions({ esmExtension: "js" })],
  },
  {
    entry: ["src/*.ts", "src/*.tsx"],
    format: ["cjs", "esm"],
    target: ["es2020", "node16"],
    outDir: "build/legacy",
    dts: true,
    sourcemap: true,
    clean: true,
    noExternal: ["@trigger.dev/internal"],
    esbuildPlugins: [esbuildPluginFilePathExtensions({ esmExtension: "js" })],
  },
]);

// {
//   entry: ["src/*.ts", "src/*.tsx"],
//   format: ["cjs", "esm"],
//   target: ["es2020", "node16"],
//   outDir: "dist",
//   dts: true,
//   sourcemap: true,
//   clean: true,
//   outExtension({ format }) {
//     switch (format) {
//       case "cjs":
//         return { js: ".cjs" };
//       case "esm":
//         return { js: ".js" };
//       default:
//         return { js: ".js" };
//     }
//   },
// },
