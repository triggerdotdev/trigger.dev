#!/usr/bin/env node

import { Command } from "commander";

import { logger } from "../src/utilities/logger";
import { configureCompileCommand } from "./compile";

const program = new Command();

program.name("trigger.e2e").description("trigger.dev program integration and e2e testing");

configureCompileCommand(program);

const main = async () => {
  await program.parseAsync();
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
