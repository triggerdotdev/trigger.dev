import fs from "fs";
import path from "path";
import axios from "axios";
import inquirer from "inquirer";
import { installDependencies } from "../utils/installDependencies.js";

export async function updateCommand(projectPath: string) {
  const packageJsonPath = path.join(projectPath, "package.json");

  if (!fs.existsSync(packageJsonPath)) {
    console.error("package.json not found in the current directory.");
    return;
  }

  const packageJsonData = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  const dependencies = packageJsonData.dependencies || {};
  const devDependencies = packageJsonData.devDependencies || {};

  const triggerPackages = Object.keys({ ...dependencies, ...devDependencies }).filter(
    (packageName) => packageName.startsWith("@trigger.dev/")
  );

  if (triggerPackages.length === 0) {
    console.log("No @trigger.dev/* packages found in package.json.");
    return;
  }

  const newVersions = await Promise.all(
    triggerPackages.map(async (packageName) => {
      try {
        const response = await axios.get(`https://registry.npmjs.org/${packageName}`);
        const latestVersion = response.data["dist-tags"].latest;
        return { packageName, latestVersion };
      } catch (error) {
        // @ts-ignore
        console.error(`Error fetching version for ${packageName}: ${error.message}`);
        return null;
      }
    })
  );
  const packagesToUpdate = newVersions.filter(
    (entry) => entry !== null && entry.latestVersion !== dependencies[entry.packageName]
  );

  if (packagesToUpdate.length === 0) {
    console.log("All @trigger.dev/* packages are up to date.");
    return;
  }

  console.log("Newer versions found for the following packages:");
  packagesToUpdate.forEach((entry) => {
    console.log(
      `- ${entry.packageName}: current ${dependencies[entry.packageName]} -> latest ${
        entry.latestVersion
      }`
    );
  });

  const { confirm } = await inquirer.prompt({
    type: "confirm",
    name: "confirm",
    message: "Do you want to update these packages in package.json and re-install dependencies?",
  });

  if (confirm) {
    packagesToUpdate.forEach((entry) => {
      dependencies[entry.packageName] = entry.latestVersion;
    });

    fs.writeFileSync(packageJsonPath, JSON.stringify(packageJsonData, null, 2));

    console.log("package.json updated. Reinstalling dependencies...");
    await installDependencies(projectPath);
  } else {
    console.log("Operation canceled. No changes were made.");
  }
}
