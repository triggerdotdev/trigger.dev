#!/usr/bin/env node

import { join } from "node:path";

import { ReadConfigResult } from "../src/utilities/configFiles.js";
import { writeJSONFile } from "../src/utilities/fileSystem.js";
import { logger } from "../src/utilities/logger.js";
import { JavascriptProject } from "../src/utilities/javascriptProject.js";
import {
  copyAdditionalFiles,
  resolveDependencies,
  resolveRequiredDependencies,
} from "../src/commands/deploy.js";
import terminalLink from "terminal-link";
import { SkipLoggingError } from "../src/cli/common.js";
import { log } from "@clack/prompts";
import { Metafile } from "esbuild";

type HandleDependenciesOptions = {
  entryPointMetaOutput: Metafile["outputs"]["out/stdin.js"];
  metaOutput: Metafile["outputs"]["out/stdin.js"];
  resolvedConfig: ReadConfigResult;
  tempDir: string;
};

export async function handleDependencies(options: HandleDependenciesOptions) {
  if (options.resolvedConfig.status === "error") {
    throw new Error("cannot resolve config");
  }
  const {
    entryPointMetaOutput,
    metaOutput,
    resolvedConfig: { config },
    tempDir,
  } = options;

  // COPIED FROM compileProject()
  logger.debug("Getting the imports for the worker and entryPoint builds", {
    workerImports: metaOutput.imports,
    entryPointImports: entryPointMetaOutput.imports,
  });

  // Get all the required dependencies from the metaOutputs and save them to /tmp/dir/package.json
  const allImports = [...metaOutput.imports, ...entryPointMetaOutput.imports];

  const javascriptProject = new JavascriptProject(config.projectDir);

  const dependencies = await resolveRequiredDependencies(allImports, config, javascriptProject);

  logger.debug("gatherRequiredDependencies()", { dependencies });

  const packageJsonContents = {
    name: "trigger-worker",
    version: "0.0.0",
    description: "",
    dependencies,
    scripts: {
      ...javascriptProject.scripts,
    },
  };

  // span.setAttributes({
  //   ...flattenAttributes(packageJsonContents, "packageJson.contents"),
  // });

  await writeJSONFile(join(tempDir, "package.json"), packageJsonContents);

  const copyResult = await copyAdditionalFiles(config, tempDir);

  if (!copyResult.ok) {
    // compileSpinner.stop("Project built with warnings");

    log.warn(
      `No additionalFiles matches for:\n\n${copyResult.noMatches
        .map((glob) => `- "${glob}"`)
        .join("\n")}\n\nIf this is unexpected you should check your ${terminalLink(
        "glob patterns",
        "https://github.com/isaacs/node-glob?tab=readme-ov-file#glob-primer"
      )} are valid.`
    );
  }
  // } else {
  //   compileSpinner.stop("Project built successfully");
  // }

  const resolvingDependenciesResult = await resolveDependencies(
    tempDir,
    packageJsonContents,
    config
  );

  if (!resolvingDependenciesResult) {
    throw new SkipLoggingError("Failed to resolve dependencies");
  }
}
