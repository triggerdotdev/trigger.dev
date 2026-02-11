#!/usr/bin/env node

import { program } from "./cli/index.js";
import { logger } from "./utilities/logger.js";
import { ensureSufficientMemory } from "./utilities/memory.js";

const main = async () => {
  if (ensureSufficientMemory()) {
    return;
  }

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
