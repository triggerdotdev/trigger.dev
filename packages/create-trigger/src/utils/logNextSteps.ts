import { DEFAULT_APP_NAME, TRIGGER_BASE_URL } from "../consts.js";
import { getUserPkgManager } from "./getUserPkgManager.js";
import { logger } from "./logger.js";
import { whoami } from "./triggerApi.js";

// This logs the next steps that the user should take in order to advance the project
export async function logNextSteps({
  projectName = DEFAULT_APP_NAME,
  noInstall,
  apiKey,
}: {
  projectName: string;
  noInstall: boolean;
  apiKey?: string;
}) {
  const pkgManager = getUserPkgManager();

  logger.info("Next steps:");
  projectName !== "." && logger.info(`  cd ${projectName}`);
  if (noInstall) {
    // To reflect yarn's default behavior of installing packages when no additional args provided
    if (pkgManager === "yarn") {
      logger.info(`  ${pkgManager}`);
    } else {
      logger.info(`  ${pkgManager} install`);
    }
  }

  if (!apiKey) {
    logger.info(
      `  visit ${TRIGGER_BASE_URL} to get your development API key and update your .env file`
    );
  }

  logger.info(`  ${pkgManager === "npm" ? "npm run" : pkgManager} dev`);

  if (apiKey) {
    const org = await whoami(apiKey);

    if (org) {
      logger.info(
        `  visit ${TRIGGER_BASE_URL}/orgs/${org.organizationSlug} to see your triggers`
      );
    }
  }
}
