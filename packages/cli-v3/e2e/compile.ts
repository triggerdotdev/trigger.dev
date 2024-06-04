#!/usr/bin/env node

import { esbuildDecorators } from "@anatine/esbuild-decorators";
import { Command, Option } from "commander";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import invariant from "tiny-invariant";
import { z } from "zod";
import { fromZodError } from "zod-validation-error";

import {
  bundleDependenciesPlugin,
  mockServerOnlyPlugin,
  workerSetupImportConfigPlugin,
} from "../src/utilities/build.js";
import { readConfig } from "../src/utilities/configFiles.js";
import { writeJSONFile } from "../src/utilities/fileSystem.js";
import { logger } from "../src/utilities/logger.js";
import { cliRootPath } from "../src/utilities/resolveInternalFilePath.js";
import { createTaskFileImports, gatherTaskFiles } from "../src/utilities/taskFiles.js";
import { escapeImportPath, spinner } from "../src/utilities/windows.js";

const CompileCommandOptionsSchema = z.object({
  logLevel: z.enum(["debug", "info", "log", "warn", "error", "none"]).default("log"),
  skipTypecheck: z.boolean().default(false),
  outputMetafile: z.string().optional(),
});

export type CompileCommandOptions = z.infer<typeof CompileCommandOptionsSchema>;

export function configureCompileCommand(program: Command) {
  program
    .command("deploy-compile")
    .argument(
      "[dir]",
      "The project root directory. Usually where the top level package.json is located."
    )
    .option(
      "-l, --log-level <level>",
      "The CLI log level to use (debug, info, log, warn, error, none). This does not effect the log level of your trigger.dev tasks.",
      "log"
    )
    .option("--skip-typecheck", "Whether to skip the pre-build typecheck")
    .addOption(
      new Option(
        "--output-metafile <path>",
        "If provided, will save the esbuild metafile for the build to the specified path"
      ).hideHelp()
    )
    .action(compile);
}

async function compile(dir: string, options: CompileCommandOptions) {
  const parsedOptions = CompileCommandOptionsSchema.safeParse(options);
  if (!parsedOptions.success) {
    throw new Error(fromZodError(parsedOptions.error).toString());
  }
  logger.loggerLevel = parsedOptions.data.logLevel;

  const resolvedConfig = await readConfig(dir);

  if (resolvedConfig.status === "error") {
    throw new Error(`cannot resolve config in directory ${dir}`);
  }

  const { config } = resolvedConfig;
  const configPath = resolvedConfig.status === "file" ? resolvedConfig.path : undefined;

  // COPIED FROM compileProject()
  // const compileSpinner = spinner();
  // compileSpinner.start(`Building project in ${config.projectDir}`);

  const taskFiles = await gatherTaskFiles(config);
  const workerFacade = readFileSync(
    join(cliRootPath(), "workers", "prod", "worker-facade.js"),
    "utf-8"
  );

  const workerSetupPath = join(cliRootPath(), "workers", "prod", "worker-setup.js");

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
      resolveDir: process.cwd(),
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
    outdir: "out",
    banner: {
      js: `process.on("uncaughtException", function(error, origin) { if (error instanceof Error) { process.send && process.send({ type: "EVENT", message: { type: "UNCAUGHT_EXCEPTION", payload: { error: { name: error.name, message: error.message, stack: error.stack }, origin }, version: "v1" } }); } else { process.send && process.send({ type: "EVENT", message: { type: "UNCAUGHT_EXCEPTION", payload: { error: { name: "Error", message: typeof error === "string" ? error : JSON.stringify(error) }, origin }, version: "v1" } }); } });`,
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
    join(cliRootPath(), "workers", "prod", "entry-point.js"),
    "utf-8"
  );

  const entryPointResult = await build({
    stdin: {
      contents: entryPointContents,
      resolveDir: process.cwd(),
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
    outdir: "out",
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
  const tempDir = await mkdir(join(config.projectDir, ".trigger"), { recursive: true });

  logger.debug(`Writing compiled files to ${tempDir}`);

  // Get the metaOutput for the result build
  const metaOutput = result.metafile!.outputs[posix.join("out", "stdin.js")];

  invariant(metaOutput, "Meta output for the result build is missing");

  // Get the metaOutput for the entryPoint build
  const entryPointMetaOutput = entryPointResult.metafile!.outputs[posix.join("out", "stdin.js")];

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
    join(tempDir!, "worker.js"),
    `${workerOutputFile.text}\n//# sourceMappingURL=worker.js.map`
  );
  // Save the sourceMapFile to /tmp/dir/worker.js.map
  await writeFile(join(tempDir!, "worker.js.map"), workerSourcemapFile.text);
  // Save the entryPoint outputFile to /tmp/dir/index.js
  await writeFile(join(tempDir!, "index.js"), entryPointOutputFile.text);
}
