#!/usr/bin/env node

import { log } from "@clack/prompts";
import { Metafile } from "esbuild";
import { join } from "node:path";

import { SkipLoggingError } from "../src/cli/common.js";
import {
  copyAdditionalFiles,
  resolveDependencies,
  resolveRequiredDependencies,
} from "../src/commands/deploy.js";
import { ReadConfigResult } from "../src/utilities/configFiles.js";
import { writeJSONFile } from "../src/utilities/fileSystem.js";
import { PackageManager } from "../src/utilities/getUserPackageManager.js";
import { JavascriptProject } from "../src/utilities/javascriptProject.js";
import { logger } from "../src/utilities/logger.js";
import { cliLink } from "../src/utilities/cliOutput.js";

type HandleDependenciesOptions = {
  entryPointMetaOutput: Metafile["outputs"]["out/stdin.js"];
  metaOutput: Metafile["outputs"]["out/stdin.js"];
  packageManager: PackageManager;
  resolvedConfig: ReadConfigResult;
  tempDir: string;
};

class JavascriptProjectLocal extends JavascriptProject {
  constructor(
    projectPath: string,
    private overridenPackageManager: PackageManager
  ) {
    super(projectPath);
  }

  async getPackageManager(): Promise<PackageManager> {
    return Promise.resolve(this.overridenPackageManager);
  }
}

export async function handleDependencies(options: HandleDependenciesOptions) {
  if (options.resolvedConfig.status === "error") {
    throw new Error("cannot resolve config");
  }
  const {
    entryPointMetaOutput,
    metaOutput,
    packageManager,
    resolvedConfig: { config },
    tempDir,
  } = options;

  logger.debug("Getting the imports for the worker and entryPoint builds", {
    workerImports: metaOutput.imports,
    entryPointImports: entryPointMetaOutput.imports,
  });

  // Get all the required dependencies from the metaOutputs and save them to /tmp/dir/package.json
  const allImports = [...metaOutput.imports, ...entryPointMetaOutput.imports];

  const javascriptProject = new JavascriptProjectLocal(config.projectDir, packageManager);

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
  await writeJSONFile(join(tempDir, "package.json"), packageJsonContents);

  const copyResult = await copyAdditionalFiles(config, tempDir);

  if (!copyResult.ok) {
    log.warn(
      `No additionalFiles matches for:\n\n${copyResult.noMatches
        .map((glob) => `- "${glob}"`)
        .join("\n")}\n\nIf this is unexpected you should check your ${cliLink(
        "glob patterns",
        "https://github.com/isaacs/node-glob?tab=readme-ov-file#glob-primer"
      )} are valid.`
    );
  }

  const resolvingDependenciesResult = await resolveDependencies(
    tempDir,
    packageJsonContents,
    config
  );

  if (!resolvingDependenciesResult) {
    throw new SkipLoggingError("Failed to resolve dependencies");
  }

  return dependencies;
}
