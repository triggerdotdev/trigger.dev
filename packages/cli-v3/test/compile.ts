#!/usr/bin/env node

import { Command } from "commander";

import { logger } from "../src/utilities/logger.js";
import { compileProject, DeployCommandOptions } from "../src/commands/deploy.js";
import { readConfig } from "../src/utilities/configFiles.js";
import type { DeployCommandOptions as DeployCommandOptionsType } from "../src/commands/deploy.js";

const defaultOptions: DeployCommandOptionsType = DeployCommandOptions.parse({
  env: "staging",
});

const testProgram = new Command();

testProgram.name("trigger.test").description("trigger.dev program testing");

testProgram
  .command("deploy-compile")
  .argument(
    "[dir]",
    "The project root directory. Usually where the top level package.json is located."
  )
  .action(async (dir) => {
    let options = defaultOptions;
    try {
      options = {
        ...options,
        ...(await import(`${dir}/options.test.json`)),
      };
    } catch (e) {
      logger.error(e);
    }

    const resolvedConfig = await readConfig(dir, {
      configFile: options.config,
      projectRef: options.projectRef,
    });

    if (resolvedConfig.status === "error") {
      throw new Error(`cannot resolve config in directory ${dir}`);
    }

    await compileProject(
      resolvedConfig.config,
      options,
      resolvedConfig.status === "file" ? resolvedConfig.path : undefined
    );
  });

const main = async () => {
  await testProgram.parseAsync();
};

main().catch((err) => {
  if (err instanceof Error) {
    logger.error(err);
  } else {
    logger.error("An unknown error has occurred. Please open an issue on github with the below:");
    logger.error(err);
  }
  process.exit(1);
});
