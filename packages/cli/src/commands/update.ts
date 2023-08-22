import path from "path";
import inquirer from "inquirer";
import { run, RunOptions } from "npm-check-updates";
import { installDependencies } from "../utils/installDependencies.js";
import { readJSONFileSync, writeJSONFile } from "../utils/fileSystem.js";

export async function updateCommand(projectPath: string) {
  const triggerDevPackage = "@trigger.dev";
  const packageJSONPath = path.join(projectPath, "package.json")
  const packageData = readJSONFileSync(packageJSONPath);

  if (!packageData) {
    return;
  }

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

  // Use npm-check-updates to get updated dependency versions
  const ncuOptions: RunOptions = {
    packageData,
    upgrade: true,
    jsonUpgraded: true,
  };

  // Can either give a json like package.json or just with deps and their new versions
  const updatedDependencies: { [k: string]: any } | void = await run(ncuOptions);

  if (!updatedDependencies) return;

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
    console.log("No @trigger.dev/* packages found in package.json.");
    return;
  }

  // Filter the packages with null and what don't match what
  // they are installed with so that they can be updated
  const packagesToUpdate = triggerPackages.filter((pkg: string) => updatedDependencies[pkg]);

  // If no packages require any updation
  if (packagesToUpdate.length === 0) {
    console.log("All @trigger.dev/* packages are up to date.");
    return;
  }

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
  const { confirm } = await inquirer.prompt({
    type: "confirm",
    name: "confirm",
    message: "Do you want to update these packages in package.json and re-install dependencies?",
  });

  if (confirm) {
    const newPackageJSON = packageData;
    packagesToUpdate.forEach((packageName) => {
      const tmp = packageMaps[packageName];
      if (tmp) {
        newPackageJSON[tmp.type][packageName] = updatedDependencies[packageName];
      }
    });
    await writeJSONFile(packageJSONPath, newPackageJSON);
    console.log("package.json updated. Reinstalling dependencies...");
    await installDependencies(projectPath);
  } else {
    console.log("Operation canceled. No changes were made.");
  }
}
