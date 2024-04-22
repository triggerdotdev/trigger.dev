import { confirm, intro, isCancel, log, outro } from "@clack/prompts";
import { RunOptions, run as ncuRun } from "npm-check-updates";
import { z } from "zod";
import { readJSONFile, removeFile, writeJSONFile } from "../utilities/fileSystem.js";
import { spinner } from "../utilities/windows.js";
import { CommonCommandOptions, OutroCommandError, wrapCommandAction } from "../cli/common.js";
import { Command } from "commander";
import { logger } from "../utilities/logger.js";
import { PackageJson } from "type-fest";
import { printStandloneInitialBanner, updateCheck } from "../utilities/initialBanner.js";
import { join, resolve } from "path";
import { JavascriptProject } from "../utilities/javascriptProject.js";
import { PackageManager } from "../utilities/getUserPackageManager.js";
import { getVersion } from "../utilities/getVersion.js";
import { chalkError, prettyWarning } from "../utilities/cliOutput.js";

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
  requireUpdate?: boolean
) {
  if (!embedded) {
    intro("Updating packages");
  }

  const projectPath = resolve(process.cwd(), dir);

  const { packageJson, readonlyPackageJson, packageJsonPath } = await getPackageJson(projectPath);

  if (!packageJson) {
    log.error("Failed to load package.json. Try to re-run with `-l debug` to see what's going on.");
    return;
  }

  const cliVersion = getVersion();
  const newCliVersion = await updateCheck();

  if (newCliVersion) {
    prettyWarning(
      "You're not running the latest CLI version, please consider updating ASAP",
      "To update, run: `(p)npm i trigger.dev@beta`\nOr run with:    `(p)npx trigger.dev@beta`",
      "Yarn works too!"
    );
  }

  const triggerDependencies = getTriggerDependencies(packageJson);

  function getVersionMismatches(deps: Dependency[], targetVersion: string): Dependency[] {
    const mismatches: Dependency[] = [];

    for (const dep of deps) {
      if (dep.version === targetVersion) {
        continue;
      }

      mismatches.push(dep);
    }

    return mismatches;
  }

  const versionMismatches = getVersionMismatches(triggerDependencies, cliVersion);

  if (versionMismatches.length === 0) {
    if (!embedded) {
      outro(`Nothing to do${newCliVersion ? " ..but you should really update your CLI!" : ""}`);
    }
    return;
  }

  prettyWarning(
    "Mismatch between your CLI version and installed packages",
    "We recommend pinned versions for guaranteed compatibility"
  );

  log.message(""); // spacing

  // FIXME: What happens without TTY? Packages shouldn't be updated in CI.

  // Always require user confirmation
  const userWantsToUpdate = await updateConfirmation(versionMismatches, cliVersion);

  if (isCancel(userWantsToUpdate)) {
    throw new OutroCommandError();
  }

  if (!userWantsToUpdate) {
    if (requireUpdate) {
      if (!embedded) {
        outro("You shall not pass!");
      }

      logger.log(
        `${chalkError(
          "X Error:"
        )} Update required. Use \`--skip-update-check\` to enter a world of pain.`
      );
      process.exit(1);
    }

    if (!embedded) {
      outro("You've been warned!");
    }

    return;
  }

  const installSpinner = spinner();
  installSpinner.start("Writing new package.json file");

  // Backup package.json
  const packageJsonBackupPath = `${packageJsonPath}.bak`;
  await writeJSONFile(packageJsonBackupPath, readonlyPackageJson, true);

  const exitHandler = async (sig: any) => {
    log.warn(
      `You may have to manually roll back any package.json changes. Backup written to ${packageJsonBackupPath}`
    );
  };

  // Add exit handler to warn about manual rollback of package.json
  // Automatically rolling back can end up overwriting with an empty file instead
  process.prependOnceListener("exit", exitHandler);

  // Update package.json
  mutatePackageJsonWithUpdatedPackages(packageJson, versionMismatches, cliVersion);
  await writeJSONFile(packageJsonPath, packageJson, true);

  async function revertPackageJsonChanges() {
    await writeJSONFile(packageJsonPath, readonlyPackageJson, true);
    await removeFile(packageJsonBackupPath);
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

    // Remove exit handler in case of failure
    process.removeListener("exit", exitHandler);

    await revertPackageJsonChanges();
    throw error;
  }

  installSpinner.stop("Installed new package versions");

  // Remove exit handler once packages have been updated, also delete backup file
  process.removeListener("exit", exitHandler);
  await removeFile(packageJsonBackupPath);

  if (!embedded) {
    outro(
      `Packages updated${newCliVersion ? " ..but you should really update your CLI too!" : ""}`
    );
  }
}

type Dependency = {
  type: "dependencies" | "devDependencies";
  name: string;
  version: string;
};

function getTriggerDependencies(packageJson: PackageJson): Dependency[] {
  const deps: Dependency[] = [];

  for (const type of ["dependencies", "devDependencies"] as const) {
    for (const [name, version] of Object.entries(packageJson[type] ?? {})) {
      if (!version) {
        continue;
      }

      if (version.startsWith("workspace")) {
        continue;
      }

      if (!triggerPackageFilter.test(name)) {
        continue;
      }

      deps.push({ type, name, version });
    }
  }

  return deps;
}

function mutatePackageJsonWithUpdatedPackages(
  packageJson: PackageJson,
  depsToUpdate: Dependency[],
  targetVersion: string
) {
  for (const { type, name, version } of depsToUpdate) {
    if (!packageJson[type]) {
      throw new Error(
        `No ${type} entry found in package.json. Please try to upgrade manually instead.`
      );
    }

    packageJson[type]![name] = targetVersion;
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

function printUpdateTable(depsToUpdate: Dependency[], targetVersion: string): void {
  log.message("Suggested updates");

  const tableData = depsToUpdate.map((dep) => ({
    package: dep.name,
    old: dep.version,
    new: targetVersion,
  }));

  logger.table(tableData);
}

async function updateConfirmation(depsToUpdate: Dependency[], targetVersion: string) {
  printUpdateTable(depsToUpdate, targetVersion);

  let confirmMessage = "Would you like to apply those updates?";

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
