import fs from "node:fs/promises";
import path from "node:path";
import * as esbuild from "esbuild";
import type { BuildOptions, Plugin, BuildContext } from "esbuild";

const EXTERNAL_DEPENDENCIES = ["chokidar"];

// the expectation is that this is being run from the project root
type BuildFlags = {
  watch?: boolean;
};

const WATCH = process.argv.includes("--watch");
const TEMPLATES_DIR = path.join(__dirname, "../templates");

async function buildMain(flags: BuildFlags = {}) {
  const outdir = path.resolve("./dist");
  const packageDirectory = path.resolve(".");

  /**
   * This is exposed in the source via the `getBasePath()` function, which should be used
   * in place of `__dirname` and similar Node.js constants.
   */
  const __RELATIVE_PACKAGE_PATH__ = `"${path.relative(outdir, packageDirectory)}"`;

  const options: BuildOptions = {
    keepNames: true,
    entryPoints: ["./src/cli.ts"],
    bundle: true,
    outdir,
    platform: "node",
    format: "cjs",
    external: EXTERNAL_DEPENDENCIES,
    sourcemap: process.env.SOURCEMAPS !== "false",
    inject: [path.join(__dirname, "../importMetaUrl.js")],
    // This is required to support jsonc-parser. See https://github.com/microsoft/node-jsonc-parser/issues/57
    mainFields: ["module", "main"],
    define: {
      __RELATIVE_PACKAGE_PATH__,
      "import.meta.url": "import_meta_url",
      "process.env.NODE_ENV": `'${process.env.NODE_ENV || "production"}'`,
      ...(process.env.POSTHOG_KEY ? { POSTHOG_KEY: `"${process.env.POSTHOG_KEY}"` } : {}),
    },
  };

  if (flags.watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
  } else {
    await esbuild.build(options);
  }
}

async function run() {
  // main cli
  await buildMain();

  // After built once completely, rerun in watch mode
  if (WATCH) {
    console.log("Built. Watching for changes...");
    await buildMain({ watch: true });
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
