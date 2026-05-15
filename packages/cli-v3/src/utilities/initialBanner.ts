import chalk from "chalk";
import { getLatestVersion } from "fast-npm-meta";
import * as semver from "semver";
import { VERSION } from "../version.js";
import { chalkGrey, chalkRun, chalkTask, chalkWorker, logo } from "./cliOutput.js";
import { logger } from "./logger.js";
import { spinner } from "./windows.js";
import {
  DEFFAULT_PROFILE,
  readAuthConfigCurrentProfileName,
  readAuthConfigProfile,
} from "./configFiles.js";
import { CLOUD_API_URL } from "../consts.js";

function getProfileInfo(profileName?: string) {
  const currentProfile = profileName ?? readAuthConfigCurrentProfileName();
  const profile = readAuthConfigProfile(currentProfile);

  if (currentProfile === DEFFAULT_PROFILE || !profile) {
    return;
  }

  return `Profile: ${currentProfile}${
    profile.apiUrl === CLOUD_API_URL ? "" : ` - ${profile.apiUrl}`
  }`;
}

export async function printInitialBanner(performUpdateCheck = true, profile?: string) {
  const profileInfo = getProfileInfo(profile);

  const text = `\n${logo()} ${chalkGrey(`(${VERSION})`)}${
    profileInfo ? chalkGrey(` | ${profileInfo}`) : ""
  }\n`;

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

export async function printStandloneInitialBanner(performUpdateCheck = true, profile?: string) {
  const profileInfo = getProfileInfo(profile);
  const profileText = profileInfo ? chalkGrey(` | ${profileInfo}`) : "";

  let versionText = `\n${logo()} ${chalkGrey(`(${VERSION})`)}`;

  if (performUpdateCheck) {
    const maybeNewVersion = await updateCheck();

    // Log a slightly more noticeable message if this is a major bump
    if (maybeNewVersion !== undefined) {
      versionText = `\n${logo()} ${chalkGrey(`(${VERSION} -> ${chalk.green(maybeNewVersion)})`)}`;
    } else {
      versionText = `\n${logo()} ${chalkGrey(`(${VERSION})`)}`;
    }
  }

  logger.log(`${versionText}${profileText}`);
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

    // Use real semver comparison (loose) so prereleases sort correctly against
    // their stable counterpart — e.g. a user on `4.5.0-rc.0` sees `4.5.0` as
    // newer. String/locale comparison gets this wrong for `X.Y.Z-rc.N` vs `X.Y.Z`.
    if (semver.lt(VERSION, meta.version, true)) {
      return meta.version;
    }

    return;
  } catch (err) {
    // ignore error (covers both network failures and any version-parse oddities)
    logger.debug(err);

    return;
  }
}

//only do this once while the cli is running
let updateCheckPromise: Promise<string | undefined>;
export function updateCheck(): Promise<string | undefined> {
  return (updateCheckPromise ??= doUpdateCheck());
}
