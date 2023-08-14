import z from "zod";
import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import inquirer from "inquirer";
import { spawnSync } from "child_process";
import { installDependencies } from "../utils/installDependencies.js";
import { getUserPackageManager } from "../utils/getUserPkgManager.js";

interface YarnListOutput {
  data: {
    trees: Array<{ name: string; version: string }>;
  };
}

function getInstalledVersion(packageName: string, packageManager: string, projectPath: string) {
  let installedVersion = null;
  if (packageManager === "npm" || packageManager === "pnpm") {
    const { stdout } = spawnSync(packageManager, ["list", packageName, "--json", "--depth=0"], {
      cwd: projectPath,
    });
    installedVersion = JSON.parse(stdout.toString()).dependencies[packageName].version;
  } else if (packageManager === "yarn") {
    const { stdout } = spawnSync(packageManager, ["list", "--json", "--depth=0"], {
      cwd: projectPath,
    });
    const parsedOutput: YarnListOutput = JSON.parse(stdout.toString());
    if (Array.isArray(parsedOutput.data.trees)) {
      const tree = parsedOutput.data.trees.find((tree) => tree.name === packageName);
      if (tree) {
        installedVersion = tree.version;
      }
    }
  }
  return installedVersion;
}

export async function updateCommand(projectPath: string) {
  const triggerDevPackage = "@trigger.dev";
  const packageManager = await getUserPackageManager(projectPath);
  const packageJsonPath = path.join(projectPath, "package.json");
  // In case no package.json found
  if (!fs.existsSync(packageJsonPath)) {
    console.error(`package.json not found in the ${projectPath} directory.`);
    return;
  }
  const packageJsonData = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  const dependencies = packageJsonData.dependencies || {};
  const devDependencies = packageJsonData.devDependencies || {};
  const allDependencies = Object.keys({ ...dependencies, ...devDependencies });
  const triggerPackages = allDependencies.filter((pkg) => pkg.startsWith(triggerDevPackage));
  // If there are no @trigger.dev packages
  if (triggerPackages.length === 0) {
    console.log("No @trigger.dev/* packages found in package.json.");
    return;
  }
  // Get an array of the latest versions of @trigger.dev packages
  const newVersions = await Promise.all(
    triggerPackages.map(async (packageName) => {
      try {
        const installedVersion = getInstalledVersion(packageName, packageManager, projectPath);
        const response = await fetch(`https://registry.npmjs.org/${packageName}`);
        if (response.ok) {
          const data = await response.json();
          const schema = z.object({
            "dist-tags": z.object({
              latest: z.string(),
            }),
          });
          const parsed = schema.parse(data);
          return { packageName, installedVersion, latestVersion: parsed["dist-tags"].latest };
        }
        return null;
      } catch (error) {
        // @ts-ignore
        console.error(`Error fetching version for ${packageName}: ${error.message}`);
        return null;
      }
    })
  );
  // Filter the packages with null and what don't match what
  // they are installed with so that they can be updated
  const packagesToUpdate = newVersions.filter(
    (pkg) => pkg && pkg.latestVersion !== pkg.installedVersion
  );
  // If no packages require any updation
  if (packagesToUpdate.length === 0) {
    console.log("All @trigger.dev/* packages are up to date.");
    return;
  }
  // Inform the user of the dependencies that can be updated
  console.log("Newer versions found for the following packages:");
  packagesToUpdate.forEach((entry) => {
    if (entry) {
      console.log(
        `- ${entry.packageName}: current ${dependencies[entry.packageName]} -> latest ${
          entry.latestVersion
        }`
      );
    }
  });
  // Ask the user if they want to update the dependencies
  const { confirm } = await inquirer.prompt({
    type: "confirm",
    name: "confirm",
    message: "Do you want to update these packages in package.json and re-install dependencies?",
  });
  if (confirm) {
    packagesToUpdate.forEach((entry) => {
      if (entry) {
        dependencies[entry.packageName] = entry.latestVersion;
      }
    });
    fs.writeFileSync(packageJsonPath, JSON.stringify(packageJsonData, null, 2));
    console.log("package.json updated. Reinstalling dependencies...");
    await installDependencies(projectPath);
  } else {
    console.log("Operation canceled. No changes were made.");
  }
}
