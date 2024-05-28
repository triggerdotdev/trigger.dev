#!/usr/bin/env node

import { Command, Option } from "commander";
import { z } from "zod";

import { compileProject, DeployCommandOptions } from "../src/commands/deploy.js";
import { readConfig } from "../src/utilities/configFiles.js";

const CompileCommandOptionsSchema = z.object({
  skipTypecheck: z.boolean().default(false),
  config: z.string().optional(),
  projectRef: z.string().optional(),
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
    .option("--skip-typecheck", "Whether to skip the pre-build typecheck")
    .option("-c, --config <config file>", "The name of the config file, found at [path]")
    .option(
      "-p, --project-ref <project ref>",
      "The project ref. Required if there is no config file. This will override the project specified in the config file."
    )
    .addOption(
      new Option(
        "--output-metafile <path>",
        "If provided, will save the esbuild metafile for the build to the specified path"
      ).hideHelp()
    )
    .action(compile);
}

async function compile(dir: string, options: CompileCommandOptions) {
  const resolvedConfig = await readConfig(dir, {
    configFile: options.config,
    projectRef: options.projectRef,
  });

  if (resolvedConfig.status === "error") {
    throw new Error(`cannot resolve config in directory ${dir}`);
  }

  const { path } = await compileProject(
    resolvedConfig.config,
    options as DeployCommandOptions,
    resolvedConfig.status === "file" ? resolvedConfig.path : undefined
  );

  console.log(path);
}
