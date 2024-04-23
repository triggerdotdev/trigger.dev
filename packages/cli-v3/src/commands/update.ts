import { confirm, intro, isCancel, log, outro } from "@clack/prompts";
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

  if (!process.stdout.isTTY) {
    // Running in CI with version mismatch detected
    outro("Deploy failed");

    console.log(
      `ERROR: Version mismatch detected while running in CI. This won't end well. Aborting.

Please run the dev command locally and check that your CLI version matches the one printed below. Additionally, all \`@trigger.dev/*\` packages also need to match this version.

If your local CLI version doesn't match the one below, you may want to add the \`trigger.dev\` package to your dependencies. You will also have to update your workflow deploy command to \`npx trigger.dev deploy\` to ensure your pinned CLI version is used.

CLI version: ${cliVersion}

Current package versions that don't match the CLI:
${versionMismatches.map((dep) => `- ${dep.name}@${dep.version}`).join("\n")}\n`
    );
    process.exit(1);
  }

  log.message(""); // spacing

  // Always require user confirmation
  const userWantsToUpdate = await updateConfirmation(versionMismatches, cliVersion);

  if (isCancel(userWantsToUpdate)) {
    throw new OutroCommandError();
  }

  if (!userWantsToUpdate) {
    if (requireUpdate) {
      outro("You shall not pass!");

      logger.log(
        `${chalkError(
          "X Error:"
        )} Update required: Version mismatches will cause errors and headaches. Don't use \`--skip-update-check\`, just update, please.\n`
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

      const ignoredPackages = ["@trigger.dev/companyicons"];

      if (ignoredPackages.includes(name)) {
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
