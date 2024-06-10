import { esbuildDecorators } from "@anatine/esbuild-decorators";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, join, posix, resolve } from "node:path";
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

  // COPIED FROM compileProject()
  // const compileSpinner = spinner();
  // compileSpinner.start(`Building project in ${config.projectDir}`);

  const taskFiles = await gatherTaskFiles(config);
  const workerFacade = readFileSync(
    resolve("./dist/workers/prod/worker-facade.js"),
    // join(cliRootPath(), "workers", "prod", "worker-facade.js"),
    "utf-8"
  );

  // const workerSetupPath = join(cliRootPath(), "workers", "prod", "worker-setup.js");
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
      // resolveDir: process.cwd(),
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
    // outdir: "out",
    outdir: resolve(config.projectDir, "out"),
    // banner: {
    //   js: `process.on("uncaughtException", function(error, origin) { if (error instanceof Error) { process.send && process.send({ type: "EVENT", message: { type: "UNCAUGHT_EXCEPTION", payload: { error: { name: error.name, message: error.message, stack: error.stack }, origin }, version: "v1" } }); } else { process.send && process.send({ type: "EVENT", message: { type: "UNCAUGHT_EXCEPTION", payload: { error: { name: "Error", message: typeof error === "string" ? error : JSON.stringify(error) }, origin }, version: "v1" } }); } });`,
    // },
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
    // compileSpinner.stop("Build failed, aborting deployment");

    // span.setAttributes({
    //   "build.workerErrors": result.errors.map(
    //     (error) => `Error: ${error.text} at ${error.location?.file}`
    //   ),
    // });

    throw new Error("Build failed, aborting deployment");
  }

  if (options.outputMetafile) {
    await writeJSONFile(join(options.outputMetafile, "worker.json"), result.metafile);
  }

  const entryPointContents = readFileSync(
    resolve("./dist/workers/prod/entry-point.js"),
    // join(cliRootPath(), "workers", "prod", "entry-point.js"),
    "utf-8"
  );

  const entryPointResult = await build({
    stdin: {
      contents: entryPointContents,
      // resolveDir: process.cwd(),
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
    // outdir: "out",
    outdir: resolve(config.projectDir, "out"),
    define: {
      __PROJECT_CONFIG__: JSON.stringify(config),
    },
    plugins: [
      bundleDependenciesPlugin("entryPoint.ts", config.dependenciesToBundle, config.tsconfigPath),
    ],
  });

  if (entryPointResult.errors.length > 0) {
    // compileSpinner.stop("Build failed, aborting deployment");

    // span.setAttributes({
    //   "build.entryPointErrors": entryPointResult.errors.map(
    //     (error) => `Error: ${error.text} at ${error.location?.file}`
    //   ),
    // });

    throw new Error("Build failed, aborting deployment");
  }

  if (options.outputMetafile) {
    await writeJSONFile(
      join(options.outputMetafile, "entry-point.json"),
      entryPointResult.metafile
    );
  }

  // Create a tmp directory to store the build
  // const tempDir = await createTempDir();

  logger.debug(`Writing compiled files to ${tempDir}`);

  // Get the metaOutput for the result build
  // const metaOutput = result.metafile!.outputs[posix.join("out", "stdin.js")];
  const metaOutput =
    result.metafile!.outputs[
      posix.join("e2e", "fixtures", basename(config.projectDir), "out", "stdin.js")
    ];

  invariant(metaOutput, "Meta output for the result build is missing");

  // Get the metaOutput for the entryPoint build
  // const entryPointMetaOutput =
  //       entryPointResult.metafile!.outputs[posix.join("out", "stdin.js")];
  const entryPointMetaOutput =
    entryPointResult.metafile!.outputs[
      posix.join("e2e", "fixtures", basename(config.projectDir), "out", "stdin.js")
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
