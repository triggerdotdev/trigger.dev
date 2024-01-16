import { spinner, confirm } from "@clack/prompts";
import path from "path";
import { run, RunOptions } from "npm-check-updates";
import { installDependencies } from "../utilities/installDependencies";
import { readJSONFileSync, writeJSONFile } from "../utilities/fileSystem.js";
import { logger } from "../utilities/logger.js";
import { z } from "zod";
import { chalkError, chalkSuccess } from "../utilities/colors";

export const UpdateCommandOptionsSchema = z.object({
  to: z.string().optional(),
});

export type UpdateCommandOptions = z.infer<typeof UpdateCommandOptionsSchema>;

type NcuRunOptionTarget = "latest" | `@${string}`;

export async function updateCommand(projectPath: string, anyOptions: any) {
  const loadingSpinner = spinner();
  loadingSpinner.start("Checking settings");

  const parseRes = UpdateCommandOptionsSchema.safeParse(anyOptions);
  if (!parseRes.success) {
    loadingSpinner.stop(chalkError(parseRes.error.message));
    return;
  }
  const options = parseRes.data;

  const triggerDevPackage = "@trigger.dev";
  const packageJSONPath = path.join(projectPath, "package.json");
  const packageData = readJSONFileSync(packageJSONPath);
  if (!packageData) {
    loadingSpinner.stop(chalkError("Couldn't load package.json"));
    return;
  }

  loadingSpinner.message("Checking for updates");

  const packageMaps: { [k: string]: { type: string; version: string } } = {};
  const packageDependencies = packageData.dependencies || {};
  const packageDevDependencies = packageData.devDependencies || {};
  Object.keys(packageDependencies).forEach((i) => {
    packageMaps[i] = { type: "dependencies", version: packageDependencies[i] };
  });
  Object.keys(packageDevDependencies).forEach((i) => {
    packageMaps[i] = {
      type: "devDependencies",
      version: packageDevDependencies[i],
    };
  });

  const targetVersion = getTargetVersion(options.to);

  // Use npm-check-updates to get updated dependency versions
  const ncuOptions: RunOptions = {
    packageData,
    upgrade: true,
    jsonUpgraded: true,
    target: targetVersion,
  };

  // Can either give a json like package.json or just with deps and their new versions
  const updatedDependencies: { [k: string]: any } | void = await run(ncuOptions);

  if (!updatedDependencies) {
    loadingSpinner.stop(chalkError("Couldn't update dependencies"));
    return;
  }

  const ifUpdatedDependenciesIsPackageJSON =
    updatedDependencies.hasOwnProperty("dependencies") ||
    updatedDependencies.hasOwnProperty("devDependencies");

  const dependencies = updatedDependencies.dependencies || {};
  const devDependencies = updatedDependencies.devDependencies || {};

  const allDependencies = ifUpdatedDependenciesIsPackageJSON
    ? Object.keys({ ...dependencies, ...devDependencies })
    : Object.keys(updatedDependencies);

  const triggerPackages = allDependencies.filter((pkg) => pkg.startsWith(triggerDevPackage));

  // If there are no @trigger.dev packages
  if (triggerPackages.length === 0) {
    loadingSpinner.stop(chalkSuccess(`All @trigger.dev/* packages are already up to date.`));
    return;
  }

  // Filter the packages with null and what don't match what
  // they are installed with so that they can be updated
  const packagesToUpdate = triggerPackages.filter((pkg: string) => updatedDependencies[pkg]);

  // If no packages require any updation
  if (packagesToUpdate.length === 0) {
    loadingSpinner.stop(chalkSuccess(`All @trigger.dev/* packages are already up to date.`));
    return;
  }

  let applyUpdates = targetVersion !== "latest";

  if (targetVersion === "latest") {
    applyUpdates = await hasUserConfirmed(packagesToUpdate, packageMaps, updatedDependencies);
  }

  if (applyUpdates) {
    const newPackageJSON = packageData;
    packagesToUpdate.forEach((packageName) => {
      const tmp = packageMaps[packageName];
      if (tmp) {
        newPackageJSON[tmp.type][packageName] = updatedDependencies[packageName];
      }
    });
    await writeJSONFile(packageJSONPath, newPackageJSON);
    await installDependencies(projectPath);
  }
}

// expects a version number, or latest.
// if version number is specified, prepend it with '@' for ncu.
function getTargetVersion(toVersion?: string): NcuRunOptionTarget {
  if (!toVersion) {
    return "latest";
  }
  return toVersion === "latest" ? "latest" : `@${toVersion}`;
}

async function hasUserConfirmed(
  packagesToUpdate: string[],
  packageMaps: { [x: string]: { type: string; version: string } },
  updatedDependencies: { [x: string]: any }
): Promise<boolean> {
  // Inform the user of the dependencies that can be updated
  console.log("\nNewer versions found for the following packages:");
  console.table(
    packagesToUpdate.map((i) => ({
      name: i,
      old: packageMaps[i]?.version,
      new: updatedDependencies[i],
    }))
  );

  // Ask the user if they want to update the dependencies
  const shouldContinue = await confirm({
    message: "Do you want to update these packages in package.json and re-install dependencies?",
  });

  return shouldContinue as boolean;
}
