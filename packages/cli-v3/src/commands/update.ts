import { confirm, intro, isCancel, log, outro } from "@clack/prompts";
import { Command } from "commander";
import { detectPackageManager, installDependencies } from "nypm";
import { basename, dirname, resolve } from "path";
import { PackageJson, readPackageJSON, resolvePackageJSON } from "pkg-types";
import { z } from "zod";
import { CommonCommandOptions, OutroCommandError, wrapCommandAction } from "../cli/common.js";
import { chalkError, prettyError, prettyWarning } from "../utilities/cliOutput.js";
import { removeFile, writeJSONFile } from "../utilities/fileSystem.js";
import { printStandloneInitialBanner, updateCheck } from "../utilities/initialBanner.js";
import { logger } from "../utilities/logger.js";
import { spinner } from "../utilities/windows.js";
import { VERSION } from "../version.js";
import { hasTTY } from "std-env";
import nodeResolve from "resolve";
import * as semver from "semver";

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
  await updateTriggerPackages(dir, options, false);
}

export async function updateTriggerPackages(
  dir: string,
  options: UpdateCommandOptions,
  embedded?: boolean,
  requireUpdate?: boolean
): Promise<boolean> {
  let hasOutput = false;
  const cliVersion = VERSION;

  if (cliVersion.startsWith("0.0.0") && process.env.ENABLE_PRERELEASE_UPDATE_CHECKS !== "1") {
    return false;
  }

  if (!embedded) {
    intro("Updating packages");
  }

  const projectPath = resolve(process.cwd(), dir);

  const { packageJson, readonlyPackageJson, packageJsonPath } = await getPackageJson(projectPath);

  if (!packageJson) {
    log.error("Failed to load package.json. Try to re-run with `-l debug` to see what's going on.");
    return false;
  }

  const newCliVersion = await updateCheck();

  if (newCliVersion && !cliVersion.startsWith("0.0.0")) {
    prettyWarning(
      "You're not running the latest CLI version, please consider updating ASAP",
      `Current:     ${cliVersion}\nLatest:      ${newCliVersion}`,
      "Run latest:  npx trigger.dev@latest"
    );

    hasOutput = true;
  }

  const triggerDependencies = await getTriggerDependencies(packageJson, packageJsonPath);

  logger.debug("Resolved trigger deps", { triggerDependencies });

  function getVersionMismatches(
    deps: Dependency[],
    targetVersion: string
  ): {
    mismatches: Dependency[];
    isDowngrade: boolean;
  } {
    logger.debug("Checking for version mismatches", { deps, targetVersion });

    const mismatches: Dependency[] = [];

    for (const dep of deps) {
      if (
        dep.version === targetVersion ||
        dep.version.startsWith("https://pkg.pr.new") ||
        dep.version.startsWith("0.0.0")
      ) {
        continue;
      }

      mismatches.push(dep);
    }

    const isDowngrade = mismatches.some((dep) => {
      const depMinVersion = semver.minVersion(dep.version);

      if (!depMinVersion) {
        return false;
      }

      return semver.gt(depMinVersion, targetVersion);
    });

    return {
      mismatches,
      isDowngrade,
    };
  }

  const { mismatches, isDowngrade } = getVersionMismatches(triggerDependencies, cliVersion);

  logger.debug("Version mismatches", { mismatches, isDowngrade });

  if (mismatches.length === 0) {
    if (!embedded) {
      outro(`Nothing to update${newCliVersion ? " ..but you should really update your CLI!" : ""}`);
      return hasOutput;
    }
    return hasOutput;
  }

  if (embedded) {
    if (isDowngrade) {
      prettyError("Some of the installed @trigger.dev packages are newer than your CLI version");
    } else {
      if (embedded) {
        prettyWarning(
          "Mismatch between your CLI version and installed packages",
          "We recommend pinned versions for guaranteed compatibility"
        );
      }
    }
  }

  if (!hasTTY) {
    // Running in CI with version mismatch detected
    if (embedded) {
      outro("Deploy failed");
    }

    console.log(
      `ERROR: Version mismatch detected while running in CI. This won't end well. Aborting.
  
  Please run the dev command locally and check that your CLI version matches the one printed below. Additionally, all \`@trigger.dev/*\` packages also need to match this version.
  
  If your local CLI version doesn't match the one below, you may want to pin the CLI version in this CI step. To do that, just replace \`trigger.dev@beta\` with \`trigger.dev@<FULL_VERSION>\`, for example: \`npx trigger.dev@3.0.0-beta.17 deploy\`
  
  CLI version: ${cliVersion}
  
  Current package versions that don't match the CLI:
  ${mismatches.map((dep) => `- ${dep.name}@${dep.version}`).join("\n")}\n`
    );
    process.exit(1);
  }

  // WARNING: We can only start accepting user input once we know this is a TTY, otherwise, the process will exit with an error in CI
  if (isDowngrade && embedded) {
    printUpdateTable("Versions", mismatches, cliVersion, "installed", "CLI");

    outro("CLI update required!");

    logger.log(
      `${chalkError(
        "X Error:"
      )} Please update your CLI. Alternatively, use \`--skip-update-check\` at your own risk.\n`
    );
    process.exit(1);
  }

  log.message(""); // spacing

  // Always require user confirmation
  const userWantsToUpdate = await updateConfirmation(mismatches, cliVersion);

  if (isCancel(userWantsToUpdate)) {
    throw new OutroCommandError();
  }

  if (!userWantsToUpdate) {
    if (requireUpdate) {
      if (embedded) {
        outro("You shall not pass!");

        logger.log(
          `${chalkError(
            "X Error:"
          )} Update required: Version mismatches are a common source of bugs and errors. Please update or use \`--skip-update-check\` at your own risk.\n`
        );
        process.exit(1);
      } else {
        outro("No updates applied");

        process.exit(0);
      }
    }

    if (!embedded) {
      outro("You've been warned!");
    }

    return hasOutput;
  }

  const installSpinner = spinner();
  installSpinner.start("Updating dependencies in package.json");

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
  mutatePackageJsonWithUpdatedPackages(packageJson, mismatches, cliVersion);
  await writeJSONFile(packageJsonPath, packageJson, true);

  async function revertPackageJsonChanges() {
    await writeJSONFile(packageJsonPath, readonlyPackageJson, true);
    await removeFile(packageJsonBackupPath);
  }

  installSpinner.message("Installing new package versions");

  const packageManager = await detectPackageManager(projectPath);

  try {
    installSpinner.message(
      `Installing new package versions${packageManager ? ` with ${packageManager.name}` : ""}`
    );

    await installDependencies({ cwd: projectPath, silent: true });
  } catch (error) {
    installSpinner.stop(
      `Failed to install new package versions${
        packageManager ? ` with ${packageManager.name}` : ""
      }`
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

  return hasOutput;
}

type Dependency = {
  type: "dependencies" | "devDependencies";
  name: string;
  version: string;
};

async function getTriggerDependencies(
  packageJson: PackageJson,
  packageJsonPath: string
): Promise<Dependency[]> {
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

      const $version = await tryResolveTriggerPackageVersion(name, packageJsonPath);

      deps.push({ type, name, version: $version ?? version });
    }
  }

  return deps;
}

async function tryResolveTriggerPackageVersion(
  name: string,
  packageJsonPath: string
): Promise<string | undefined> {
  try {
    const resolvedPath = nodeResolve.sync(name, {
      basedir: dirname(packageJsonPath),
    });

    logger.debug(`Resolved ${name} package version path`, { name, resolvedPath });

    // IMPORTANT: keep the two dirname calls, as the first one resolves the nested package.json inside dist/commonjs or dist/esm
    const { packageJson } = await getPackageJson(dirname(dirname(resolvedPath)));

    if (packageJson.version) {
      logger.debug(`Resolved ${name} package version`, { name, version: packageJson.version });
      return packageJson.version;
    }

    return;
  } catch (error) {
    logger.debug("Failed to resolve package version", { name, error });
    return undefined;
  }
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

function printUpdateTable(
  heading: string,
  depsToUpdate: Dependency[],
  targetVersion: string,
  oldColumn = "old",
  newColumn = "new"
): void {
  log.message(heading);

  const tableData = depsToUpdate.map((dep) => ({
    package: dep.name,
    [oldColumn]: dep.version,
    [newColumn]: targetVersion,
  }));

  logger.table(tableData);
}

async function updateConfirmation(depsToUpdate: Dependency[], targetVersion: string) {
  printUpdateTable("Suggested updates", depsToUpdate, targetVersion);

  let confirmMessage = "Would you like to apply those updates?";

  return await confirm({
    message: confirmMessage,
  });
}

export async function getPackageJson(absoluteProjectPath: string) {
  const packageJsonPath = await resolvePackageJSON(absoluteProjectPath);
  const readonlyPackageJson = await readPackageJSON(packageJsonPath);

  const packageJson = structuredClone(readonlyPackageJson);

  return { packageJson, readonlyPackageJson, packageJsonPath };
}
