import peerDepsExternal from "rollup-plugin-peer-deps-external";
import resolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import typescript from "rollup-plugin-typescript2";
import json from "@rollup/plugin-json";
import dts from "rollup-plugin-dts";
import * as fs from "fs";

const loadJSON = (path) =>
  JSON.parse(fs.readFileSync(new URL(path, import.meta.url)));
const packageJson = loadJSON("./package.json");

export default [
  {
    input: "src/index.ts",
    output: [
      {
        file: packageJson.main,
        format: "cjs",
        exports: "named",
        sourcemap: true,
      },
      {
        file: packageJson.module,
        format: "es",
        exports: "named",
        sourcemap: true,
      },
    ],
    plugins: [
      peerDepsExternal(),
      resolve({ browser: false, preferBuiltins: true }),
      commonjs(),
      json(),
      typescript({
        useTsconfigDeclarationDir: true,
        rollupCommonJSResolveHack: false,
        clean: true,
        useTsconfigDeclarationDir: true,
      }),
    ],
    external: Object.keys(packageJson.dependencies),
  },
  // {
  //   input: "./dist/dts/@trigger.dev/integrations/src/index.d.ts",
  //   output: [{ file: "dist/index.d.ts", format: "es" }],
  //   plugins: [dts()],
  // },
];
