import chalk from "chalk";
import type { Result } from "update-check";
import checkForUpdate from "update-check";
import { chalkGrey, chalkRun, chalkTask, chalkWorker, green, logo } from "./cliOutput.js";
import { logger } from "./logger.js";
import { spinner } from "./windows.js";
import { readPackageJSON } from "pkg-types";
import { VERSION } from "../version.js";

export async function printInitialBanner(performUpdateCheck = true) {
  const text = `\n${logo()} ${chalkGrey(`(${VERSION})`)}\n`;

  logger.info(text);

  let maybeNewVersion: string | undefined;
  if (performUpdateCheck) {
    const loadingSpinner = spinner();
    loadingSpinner.start("Checking for updates");
    maybeNewVersion = await updateCheck();

    // Log a slightly more noticeable message if this is a major bump
    if (maybeNewVersion !== undefined) {
      loadingSpinner.stop(`Update available ${chalk.green(maybeNewVersion)}`);
      const currentMajor = parseInt(VERSION.split(".")[0]!);
      const newMajor = parseInt(maybeNewVersion.split(".")[0]!);
      if (newMajor > currentMajor) {
        logger.warn(
          `Please update to the latest version of \`trigger.dev\` to prevent critical errors.
Run \`npm install --save-dev trigger.dev@${newMajor}\` to update to the latest version.
After installation, run Trigger.dev with \`npx trigger.dev\`.`
        );
      }
    } else {
      loadingSpinner.stop("On latest version");
    }
  }
}

export async function printStandloneInitialBanner(performUpdateCheck = true) {
  if (performUpdateCheck) {
    const maybeNewVersion = await updateCheck();

    // Log a slightly more noticeable message if this is a major bump
    if (maybeNewVersion !== undefined) {
      logger.log(`\n${logo()} ${chalkGrey(`(${VERSION} -> ${chalk.green(maybeNewVersion)})`)}`);
    } else {
      logger.log(`\n${logo()} ${chalkGrey(`(${VERSION})`)}`);
    }
  } else {
    logger.log(`\n${logo()} ${chalkGrey(`(${VERSION})`)}`);
  }

  logger.log(`${chalkGrey("-".repeat(54))}`);
}

export function printDevBanner(printTopBorder = true) {
  if (printTopBorder) {
    logger.log(chalkGrey("-".repeat(54)));
  }

  logger.log(
    `${chalkGrey("Key:")} ${chalkWorker("Version")} ${chalkGrey("|")} ${chalkTask(
      "Task"
    )} ${chalkGrey("|")} ${chalkRun("Run")}`
  );
  logger.log(chalkGrey("-".repeat(54)));
}

async function doUpdateCheck(): Promise<string | undefined> {
  let update: Result | null = null;
  try {
    const pkg = await readPackageJSON();
    // default cache for update check is 1 day
    update = await checkForUpdate.default(pkg, {
      distTag: VERSION.startsWith("3.0.0-beta") ? "beta" : "latest",
    });
  } catch (err) {
    // ignore error
  }
  return update?.latest;
}

//only do this once while the cli is running
let updateCheckPromise: Promise<string | undefined>;
export function updateCheck(): Promise<string | undefined> {
  return (updateCheckPromise ??= doUpdateCheck());
}
