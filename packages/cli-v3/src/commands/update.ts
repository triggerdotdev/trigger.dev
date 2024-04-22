import { confirm, intro, isCancel, log, outro } from "@clack/prompts";
import { RunOptions, run as ncuRun } from "npm-check-updates";
import { z } from "zod";
import { readJSONFile, writeJSONFile } from "../utilities/fileSystem.js";
import { spinner } from "../utilities/windows.js";
import { CommonCommandOptions, OutroCommandError, wrapCommandAction } from "../cli/common.js";
import { Command } from "commander";
import { logger } from "../utilities/logger.js";
import { PackageJson } from "type-fest";
import { printStandloneInitialBanner } from "../utilities/initialBanner.js";
import { join, resolve } from "path";
import { JavascriptProject } from "../utilities/javascriptProject.js";
import { PackageManager } from "../utilities/getUserPackageManager.js";
import { getVersion } from "../utilities/getVersion.js";

export const UpdateCommandOptions = CommonCommandOptions.pick({
  logLevel: true,
  skipTelemetry: true,
});

export type UpdateCommandOptions = z.infer<typeof UpdateCommandOptions>;

export function configureUpdateCommand(program: Command) {
  return program
    .command("update")
    .description("Updates all @trigger.dev/* packages to match the CLI version")
    .argument("[path]", "The path to the directory that contains the package.json file", ".")
    .option(
      "-l, --log-level <level>",
      "The CLI log level to use (debug, info, log, warn, error, none). This does not effect the log level of your trigger.dev tasks.",
      "log"
    )
    .option("--skip-telemetry", "Opt-out of sending telemetry")
    .action(async (path, options) => {
      wrapCommandAction("dev", UpdateCommandOptions, options, async (opts) => {
        await printStandloneInitialBanner(true);
        await updateCommand(path, opts);
      });
    });
}

const NcuRunResult = z.record(z.string());
type NcuRunResult = z.infer<typeof NcuRunResult>;

const triggerPackageFilter = /^@trigger\.dev/;

export async function updateCommand(dir: string, options: UpdateCommandOptions) {
  await updateTriggerPackages(dir, options);
}

export async function updateTriggerPackages(
  dir: string,
  options: UpdateCommandOptions,
  embedded?: boolean,
  skipIntro?: boolean
) {
  if (!skipIntro) {
    intro(embedded ? "Dependency update check" : "Updating packages");
  }

  const projectPath = resolve(process.cwd(), dir);

  const updateSpinner = spinner();
  updateSpinner.start("Loading package.json");

  const { packageJson, readonlyPackageJson, packageJsonPath } = await getPackageJson(projectPath);

  if (!packageJson) {
    updateSpinner.stop("Couldn't load package.json");
    return;
  }

  updateSpinner.message("Loaded package.json");

  const cliVersion = getVersion();

  const triggerDepsToUpdate = await checkForPackageUpdates(packageJson, "beta", updateSpinner);

  if (!triggerDepsToUpdate) {
    if (!embedded) {
      outro("All done");
    }
    return;
  }

  const triggerDependencies = Object.fromEntries(
    Object.entries({ ...packageJson.dependencies, ...packageJson.devDependencies }).filter(
      ([name, version]) =>
        triggerPackageFilter.test(name) && version && !version.startsWith("workspace")
    )
  ) as Record<string, string>;

  const versionedTriggerPackages = packagesWithOldAndNewVersions(packageJson, {
    ...triggerDependencies,
    ...triggerDepsToUpdate,
  });

  const versionMismatchDetected =
    versionedTriggerPackages.length > 1 &&
    versionedTriggerPackages.some((p) => p.old !== versionedTriggerPackages[0]?.old);

  if (versionMismatchDetected) {
    log.warn(
      "Package version mismatch detected!\nPlease update all packages to the same version to prevent errors."
    );
  }

  mutatePackageJsonWithUpdatedPackages(packageJson, triggerDepsToUpdate);

  // Always require user confirmation
  const userWantsToUpdate = await updateConfirmation(
    versionedTriggerPackages,
    versionMismatchDetected
  );

  if (isCancel(userWantsToUpdate)) {
    throw new OutroCommandError();
  }

  if (!userWantsToUpdate) {
    const outroMessage = versionMismatchDetected ? "You've been warned!" : "Okay, maybe next time!";

    if (!embedded) {
      outro(outroMessage);
    }

    return;
  }

  const installSpinner = spinner();
  installSpinner.start("Writing new package.json file");

  await writeJSONFile(packageJsonPath, packageJson, true);

  async function revertPackageJsonChanges() {
    await writeJSONFile(packageJsonPath, readonlyPackageJson, true);
  }

  installSpinner.message("Installing new package versions");

  const jsProject = new JavascriptProject(projectPath);

  let packageManager: PackageManager | undefined;

  try {
    packageManager = await jsProject.getPackageManager();

    installSpinner.message(`Installing new package versions with ${packageManager}`);

    await jsProject.install();
  } catch (error) {
    installSpinner.stop(
      `Failed to install new package versions${packageManager ? ` with ${packageManager}` : ""}`
    );

    await revertPackageJsonChanges();
    throw error;
  }

  installSpinner.stop("Installed new package versions");

  if (!embedded) {
    outro("Packages updated");
  }
}

function mutatePackageJsonWithUpdatedPackages(
  packageJson: PackageJson,
  triggerDepsToUpdate: Record<string, string>
) {
  for (const [packageName, newVersion] of Object.entries(triggerDepsToUpdate)) {
    if (packageJson.dependencies?.[packageName]) {
      packageJson.dependencies[packageName] = newVersion;
      continue;
    }

    if (packageJson.devDependencies?.[packageName]) {
      packageJson.devDependencies[packageName] = newVersion;
      continue;
    }

    throw new Error(`Package to update not found in original package.json: ${packageName}`);
  }
}

function getNcuTargetVersion(version: string): RunOptions["target"] {
  switch (version) {
    case "latest":
    case "newest":
    case "greatest":
    case "minor":
    case "patch":
    case "semver":
      return version;
    default:
      return `@${version}`;
  }
}

function packagesWithOldAndNewVersions(packageJson: PackageJson, packagesToUpdate: NcuRunResult) {
  return Object.entries(packagesToUpdate).map(([packageName, newVersion]) => {
    const oldVersion =
      packageJson.dependencies?.[packageName] ?? packageJson.devDependencies?.[packageName];

    if (!oldVersion) {
      throw new Error(`Package to update not found in original package.json: ${packageName}`);
    }

    return {
      package: packageName,
      old: oldVersion,
      new: newVersion,
    };
  });
}

async function updateConfirmation(
  versionedPackages: ReturnType<typeof packagesWithOldAndNewVersions>,
  versionMismatchDetected?: boolean
) {
  logger.table(versionedPackages);

  let confirmMessage = "Would you like to update those packages?";

  if (versionMismatchDetected) {
    confirmMessage += " (Please say yes!)";
  }

  return await confirm({
    message: confirmMessage,
  });
}

export async function getPackageJson(absoluteProjectPath: string) {
  const packageJsonPath = join(absoluteProjectPath, "package.json");

  const readonlyPackageJson = Object.freeze((await readJSONFile(packageJsonPath)) as PackageJson);

  const packageJson = structuredClone(readonlyPackageJson);

  return { packageJson, readonlyPackageJson, packageJsonPath };
}

export async function checkForPackageUpdates(
  packageJson: PackageJson,
  targetVersion: string,
  existingSpinner?: ReturnType<typeof spinner>
) {
  const updateCheckSpinner = existingSpinner ?? spinner();

  updateCheckSpinner[existingSpinner ? "message" : "start"]("Checking for updates");

  const normalizedTarget = getNcuTargetVersion(targetVersion);

  // Use npm-check-updates to get updated dependency versions
  const ncuOptions: RunOptions = {
    packageData: packageJson as RunOptions["packageData"],
    target: normalizedTarget,
    filter: triggerPackageFilter,
  };

  logger.debug({ ncuOptions: JSON.stringify(ncuOptions, undefined, 2) });

  // Check for new versions of @trigger.dev packages
  const ncuRunResult = await ncuRun(ncuOptions);
  logger.debug({ ncuRunResult });

  const triggerDepsToUpdate = NcuRunResult.safeParse(ncuRunResult);

  if (!triggerDepsToUpdate.success) {
    logger.error("Failed to parse ncu result", { ncuRunResult });
    updateCheckSpinner.stop("Couldn't update dependencies");
    return;
  }

  console.log({ triggerDepsToUpdate: triggerDepsToUpdate.data });

  const totalToUpdate = Object.keys(triggerDepsToUpdate.data).length;

  if (totalToUpdate === 0) {
    updateCheckSpinner.stop("No package updates found");
    return;
  }

  updateCheckSpinner.stop("Found packages to update");

  return triggerDepsToUpdate.data;
}
