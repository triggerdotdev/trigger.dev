import { esbuildDecorators } from "@anatine/esbuild-decorators";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, join, posix, relative, resolve, sep } from "node:path";
import invariant from "tiny-invariant";

import {
  bundleDependenciesPlugin,
  mockServerOnlyPlugin,
  workerSetupImportConfigPlugin,
} from "../src/utilities/build.js";
import { ReadConfigResult } from "../src/utilities/configFiles.js";
import { writeJSONFile } from "../src/utilities/fileSystem.js";
import { logger } from "../src/utilities/logger.js";
import { createTaskFileImports, gatherTaskFiles } from "../src/utilities/taskFiles.js";
import { escapeImportPath } from "../src/utilities/windows.js";

type CompileOptions = {
  outputMetafile?: string;
  resolvedConfig: ReadConfigResult;
  tempDir: string;
};

export async function compile(options: CompileOptions) {
  if (options.resolvedConfig.status === "error") {
    throw new Error("cannot resolve config");
  }

  const {
    tempDir,
    resolvedConfig: { config },
  } = options;
  const configPath =
    options.resolvedConfig.status === "file" ? options.resolvedConfig.path : undefined;
  const taskFiles = await gatherTaskFiles(config);
  const workerFacade = readFileSync(resolve("./dist/workers/prod/worker-facade.js"), "utf-8");

  const workerSetupPath = resolve("./dist/workers/prod/worker-setup.js");

  let workerContents = workerFacade
    .replace("__TASKS__", createTaskFileImports(taskFiles))
    .replace(
      "__WORKER_SETUP__",
      `import { tracingSDK, otelTracer, otelLogger } from "${escapeImportPath(workerSetupPath)}";`
    );

  if (configPath) {
    logger.debug("Importing project config from", { configPath });

    workerContents = workerContents.replace(
      "__IMPORTED_PROJECT_CONFIG__",
      `import * as importedConfigExports from "${escapeImportPath(
        configPath
      )}"; const importedConfig = importedConfigExports.config; const handleError = importedConfigExports.handleError;`
    );
  } else {
    workerContents = workerContents.replace(
      "__IMPORTED_PROJECT_CONFIG__",
      `const importedConfig = undefined; const handleError = undefined;`
    );
  }

  const result = await build({
    stdin: {
      contents: workerContents,
      resolveDir: config.projectDir,
      sourcefile: "__entryPoint.ts",
    },
    bundle: true,
    metafile: true,
    write: false,
    minify: false,
    sourcemap: "external", // does not set the //# sourceMappingURL= comment in the file, we handle it ourselves
    logLevel: "error",
    platform: "node",
    format: "cjs", // This is needed to support opentelemetry instrumentation that uses module patching
    target: ["node18", "es2020"],
    outdir: resolve(config.projectDir, "out"),
    footer: {
      js: "process.exit();",
    },
    define: {
      TRIGGER_API_URL: `"${config.triggerUrl}"`,
      __PROJECT_CONFIG__: JSON.stringify(config),
    },
    plugins: [
      mockServerOnlyPlugin(),
      bundleDependenciesPlugin("workerFacade", config.dependenciesToBundle, config.tsconfigPath),
      workerSetupImportConfigPlugin(configPath),
      esbuildDecorators({
        tsconfig: config.tsconfigPath,
        tsx: true,
        force: false,
      }),
    ],
  });

  if (result.errors.length > 0) {
    throw new Error("Build failed, aborting deployment");
  }

  if (options.outputMetafile) {
    await writeJSONFile(join(options.outputMetafile, "worker.json"), result.metafile);
  }

  const entryPointContents = readFileSync(resolve("./dist/workers/prod/entry-point.js"), "utf-8");

  const entryPointResult = await build({
    stdin: {
      contents: entryPointContents,
      resolveDir: config.projectDir,
      sourcefile: "index.ts",
    },
    bundle: true,
    metafile: true,
    write: false,
    minify: false,
    sourcemap: false,
    logLevel: "error",
    platform: "node",
    packages: "external",
    format: "cjs", // This is needed to support opentelemetry instrumentation that uses module patching
    target: ["node18", "es2020"],
    outdir: resolve(config.projectDir, "out"),
    define: {
      __PROJECT_CONFIG__: JSON.stringify(config),
    },
    plugins: [
      bundleDependenciesPlugin("entryPoint.ts", config.dependenciesToBundle, config.tsconfigPath),
    ],
  });

  if (entryPointResult.errors.length > 0) {
    throw new Error("Build failed, aborting deployment");
  }

  if (options.outputMetafile) {
    await writeJSONFile(
      join(options.outputMetafile, "entry-point.json"),
      entryPointResult.metafile
    );
  }

  logger.debug(`Writing compiled files to ${tempDir}`);

  // Get the metaOutput for the result build
  const pathsToProjectDir = relative(
    join(process.cwd(), "e2e", "fixtures"),
    config.projectDir
  ).split(sep);

  const metaOutput =
    result.metafile!.outputs[
      posix.join("e2e", "fixtures", ...pathsToProjectDir, "out", "stdin.js")
    ];

  invariant(metaOutput, "Meta output for the result build is missing");

  // Get the metaOutput for the entryPoint build
  const entryPointMetaOutput =
    entryPointResult.metafile!.outputs[
      posix.join("e2e", "fixtures", ...pathsToProjectDir, "out", "stdin.js")
    ];

  invariant(entryPointMetaOutput, "Meta output for the entryPoint build is missing");

  // Get the outputFile and the sourceMapFile for the result build
  const workerOutputFile = result.outputFiles.find(
    (file) => file.path === join(config.projectDir, "out", "stdin.js")
  );

  invariant(workerOutputFile, "Output file for the result build is missing");

  const workerSourcemapFile = result.outputFiles.find(
    (file) => file.path === join(config.projectDir, "out", "stdin.js.map")
  );

  invariant(workerSourcemapFile, "Sourcemap file for the result build is missing");

  // Get the outputFile for the entryPoint build

  const entryPointOutputFile = entryPointResult.outputFiles.find(
    (file) => file.path === join(config.projectDir, "out", "stdin.js")
  );

  invariant(entryPointOutputFile, "Output file for the entryPoint build is missing");

  // Save the result outputFile to /tmp/dir/worker.js (and make sure to map the sourceMap to the correct location in the file)
  await writeFile(
    join(tempDir, "worker.js"),
    `${workerOutputFile.text}\n//# sourceMappingURL=worker.js.map`
  );
  // Save the sourceMapFile to /tmp/dir/worker.js.map
  await writeFile(join(tempDir, "worker.js.map"), workerSourcemapFile.text);
  // Save the entryPoint outputFile to /tmp/dir/index.js
  await writeFile(join(tempDir, "index.js"), entryPointOutputFile.text);

  return {
    workerMetaOutput: metaOutput,
    workerOutputFile,
    entryPointMetaOutput,
    entryPointOutputFile,
  };
}
