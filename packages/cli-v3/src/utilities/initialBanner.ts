import chalk from "chalk";
import checkForUpdate from "update-check";
import { logger } from "./logger";
import type { Result } from "update-check";
import { getVersion } from "./getVersion";
import pkg from "../../package.json";

export async function printInitialBanner(performUpdateCheck = true) {
  const packageVersion = getVersion();
  let text = ` ⛅️ Trigger.dev ${packageVersion}`;
  let maybeNewVersion: string | undefined;
  if (performUpdateCheck) {
    maybeNewVersion = await updateCheck();
    if (maybeNewVersion !== undefined) {
      text += ` (update available ${chalk.green(maybeNewVersion)})`;
    }
  }

  logger.log(text + "\n" + chalk.hex("#FF8800")("-".repeat(text.length)));

  // Log a slightly more noticeable message if this is a major bump
  if (maybeNewVersion !== undefined) {
    const currentMajor = parseInt(packageVersion.split(".")[0]!);
    const newMajor = parseInt(maybeNewVersion.split(".")[0]!);
    if (newMajor > currentMajor) {
      logger.warn(
        `Please update to the latest version of \`trigger.dev\` to prevent critical errors.
Run \`npm install --save-dev trigger.dev@${newMajor}\` to update to the latest version.
After installation, run Trigger.dev with \`npx trigger.dev\`.`
      );
    }
  }
}

async function doUpdateCheck(): Promise<string | undefined> {
  let update: Result | null = null;
  try {
    // default cache for update check is 1 day
    update = await checkForUpdate(pkg, {
      distTag: pkg.version.startsWith("0.0.0") ? "beta" : "latest",
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
