#!/usr/bin/env node

import { runCli } from "./cli/index.js";
import { createProject } from "./utils/createProject.js";
import { logger } from "./utils/logger.js";
import { renderTitle } from "./utils/renderTitle.js";
import { createTemplateRef } from "./utils/templateRef.js";
import { installDependencies } from "./utils/installDependencies.js";
import { initializeGit } from "./utils/git.js";
import { parseNameAndPath } from "./utils/parseNameAndPath.js";
import { logNextSteps } from "./utils/logNextSteps.js";
import { createDotEnvFile } from "./utils/createDotEnvFile.js";
import { sendTelemetry } from "./utils/triggerApi.js";
import { createTelemetryEvent } from "./utils/createTelemetryEvent.js";

const main = async () => {
  renderTitle();

  const cli = await runCli();

  const repositoryRef = createTemplateRef(cli.templateName);

  const [scopedProjectName, projectDir] = parseNameAndPath(
    cli.flags.projectName
  );

  const projectPath = await createProject(
    repositoryRef,
    projectDir,
    scopedProjectName ?? cli.templateName
  );

  if (!projectPath) {
    process.exit(1);
  }

  if (!cli.flags.noInstall) {
    await installDependencies(projectPath);
  }

  if (!cli.flags.noGit) {
    await initializeGit(projectPath);
  }

  await createDotEnvFile(projectPath, cli.flags.apiKey);

  await logNextSteps({
    projectName: projectDir,
    noInstall: cli.flags.noInstall,
    apiKey: cli.flags.apiKey,
  });

  if (!cli.flags.noTelemetry) {
    await sendTelemetry(createTelemetryEvent(cli), cli.flags.apiKey);
  }

  process.exit(0);
};

main().catch((err) => {
  logger.error("Aborting installation...");
  if (err instanceof Error) {
    logger.error(err);
  } else {
    logger.error(
      "An unknown error has occurred. Please open an issue on github with the below:"
    );
    console.log(err);
  }
  process.exit(1);
});
