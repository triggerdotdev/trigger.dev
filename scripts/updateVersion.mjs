import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readPackageJSON } from "pkg-types";

// This script will update the VERSION constant in the build output, found at:
// {cwd}/dist/esm/version.js
// {cwd}/dist/commonjs/version.js
//
// It fetches the version by reading the package.json file in the root of the project.
async function updateVersion() {
  const localPackageJson = await readPackageJSON(process.cwd());

  if (!localPackageJson.version) {
    throw new Error("Failed to read version from package.json");
  }

  const versionFileESM = path.join(process.cwd(), "dist", "esm", "version.js");
  await updatePlaceholderInFile(versionFileESM, localPackageJson.version);

  const versionFileCJS = path.join(process.cwd(), "dist", "commonjs", "version.js");
  await updatePlaceholderInFile(versionFileCJS, localPackageJson.version);

  console.log(
    `Updated packages/${path.basename(process.cwd())} version.js to ${localPackageJson.version}`
  );
}

async function updatePlaceholderInFile(filePath, version) {
  try {
    const fileContents = await fs.readFile(filePath, "utf-8");
    const updatedContents = fileContents.replace("0.0.0", version);
    await fs.writeFile(filePath, updatedContents);
  } catch (e) {}
}

updateVersion().catch((e) => {
  console.error(e);
  process.exit(1);
});

