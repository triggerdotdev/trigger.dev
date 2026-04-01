import { defineConfig } from "@trigger.dev/sdk";
import { prismaExtension } from "@trigger.dev/build/extensions/prisma";
import { esbuildPlugin } from "@trigger.dev/build/extensions";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF!,
  dirs: ["./src/trigger"],
  maxDuration: 3600,
  runtime: "node-22",
  processKeepAlive: {
    enabled: true,
    maxExecutionsPerProcess: 50,
  },
  build: {
    extensions: [
      prismaExtension({
        mode: "modern",
      }),
      // Trigger's ESM shim anchors require.resolve() to the chunk path, so
      // node-stdlib-browser's runtime require.resolve("./mock/empty.js") breaks.
      // Fix: load the real node-stdlib-browser at build time (where require.resolve
      // works), capture the resolved path map, and inline it as a static export.
      esbuildPlugin({
        name: "node-stdlib-browser-stub",
        setup(build) {
          build.onResolve({ filter: /^node-stdlib-browser$/ }, () => ({
            path: "node-stdlib-browser",
            namespace: "nsb-resolved",
          }));
          build.onLoad({ filter: /.*/, namespace: "nsb-resolved" }, () => {
            const buildRequire = createRequire(import.meta.url);
            const resolved = buildRequire("node-stdlib-browser");
            return {
              contents: `export default ${JSON.stringify(resolved)};`,
              loader: "js",
            };
          });
        },
      }),
      // @secure-exec/node's bridge-loader.js runs require.resolve("@secure-exec/core")
      // at module scope to locate dist/bridge.js on disk. This fails in Trigger's
      // Docker container where the code is bundled into chunks and the package
      // isn't on disk. Fix: inline bridge.js content at build time so no runtime
      // filesystem access or package resolution is needed.
      esbuildPlugin({
        name: "inline-secure-exec-bridge",
        setup(build) {
          build.onLoad(
            { filter: /[\\/]@secure-exec[\\/]node[\\/]dist[\\/]bridge-loader\.js$/ },
            (args) => {
              const buildRequire = createRequire(args.path);
              const coreEntry = buildRequire.resolve("@secure-exec/core");
              const coreRoot = path.resolve(path.dirname(coreEntry), "..");
              const bridgeCode = fs.readFileSync(path.join(coreRoot, "dist", "bridge.js"), "utf8");
              return {
                contents: [
                  `import { getIsolateRuntimeSource } from "@secure-exec/core";`,
                  `const bridgeCodeCache = ${JSON.stringify(bridgeCode)};`,
                  `export function getRawBridgeCode() { return bridgeCodeCache; }`,
                  `export function getBridgeAttachCode() { return getIsolateRuntimeSource("bridgeAttach"); }`,
                ].join("\n"),
                loader: "js",
              };
            },
          );
        },
      }),
    ],
    external: [
      // esbuild must not be bundled — it locates its native binary via a
      // relative path from its JS API entry point. secure-exec uses esbuild
      // at runtime to bundle polyfills for sandbox code.
      "esbuild",
    ],
    keepNames: false,
  },
});
