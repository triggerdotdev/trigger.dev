import fs from "fs";
import path from "path";
import inquirer from "inquirer";
import ncu from "npm-check-updates";
import { installDependencies } from "../utils/installDependencies.js";
import { Index } from "npm-check-updates/build/src/types/IndexType.js";

function getPackageJSON(projectPath: string) {
  const packageJsonPath = path.join(projectPath, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    console.error(`package.json not found in the ${projectPath} directory.`);
    return;
  }
  return JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
}

function setPackageJSON(projectPath: string, updatedPackageJSON: Object) {
  const packageJsonPath = path.join(projectPath, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    console.error(`package.json not found in the ${projectPath} directory.`);
    return;
  }
  fs.writeFileSync(packageJsonPath, JSON.stringify(updatedPackageJSON, null, 2), "utf8");
  return;
}

export async function updateCommand(projectPath: string) {
  const triggerDevPackage = "";
  const packageData = getPackageJSON(projectPath);

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
  const ncuOptions = {
    packageData,
    upgrade: true,
    jsonUpgraded: true,
  };

  // Can either give a json like package.json or just with deps and their new versions
  const updatedDependencies: Index | void = await new Promise((resolve, reject) =>
    ncu(ncuOptions).then(resolve).catch(reject)
  );

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
    setPackageJSON(projectPath, newPackageJSON);
    console.log("package.json updated. Reinstalling dependencies...");
    await installDependencies(projectPath);
  } else {
    console.log("Operation canceled. No changes were made.");
  }
}
