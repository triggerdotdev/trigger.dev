import chalk from "chalk";
import { getLatestVersion } from "fast-npm-meta";
import { VERSION } from "../version.js";
import { chalkGrey, chalkRun, chalkTask, chalkWorker, logo } from "./cliOutput.js";
import { logger } from "./logger.js";
import { spinner } from "./windows.js";

export async function printInitialBanner(performUpdateCheck = true) {
  const text = `\n${logo()} ${chalkGrey(`(${VERSION})`)}\n`;

  logger.info(text);

  let maybeNewVersion: string | undefined;
  if (performUpdateCheck) {
    const $spinner = spinner();
    $spinner.start("Checking for updates");
    maybeNewVersion = await updateCheck();

    // Log a slightly more noticeable message if this is a major bump
    if (maybeNewVersion !== undefined) {
      $spinner.stop(`Update available ${chalk.green(maybeNewVersion)}`);

      const currentMajor = parseInt(VERSION.split(".")[0]!);
      const newMajor = parseInt(maybeNewVersion.split(".")[0]!);

      logger.debug(`updateCheck: ${VERSION} -> ${maybeNewVersion}`);

      if (newMajor > currentMajor) {
        logger.warn(
          `Please update to the latest version of \`trigger.dev\` to prevent critical errors.
Run \`npm install --save-dev trigger.dev@${newMajor}\` to update to the latest version.
After installation, run Trigger.dev with \`npx trigger.dev\`.`
        );
      } else {
      }
    } else {
      $spinner.stop("On latest version");
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
  try {
    // default cache for update check is 1 day
    const meta = await getLatestVersion("trigger.dev@latest", { force: true });

    if (!meta.version) {
      return;
    }

    const compareVersions = (a: string, b: string) =>
      a.localeCompare(b, "en-US", { numeric: true });

    const comparison = compareVersions(VERSION, meta.version);

    if (comparison === -1) {
      return meta.version;
    }

    return;
  } catch (err) {
    // ignore error
    logger.debug(err);

    return;
  }
}

//only do this once while the cli is running
let updateCheckPromise: Promise<string | undefined>;
export function updateCheck(): Promise<string | undefined> {
  return (updateCheckPromise ??= doUpdateCheck());
}
