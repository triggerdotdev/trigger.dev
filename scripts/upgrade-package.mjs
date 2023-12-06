import { promises as fs } from "fs";
import { join } from "path";
import { exec } from "child_process";
import prettier from "prettier";

import prettierConfig from "../prettier.config.js";

async function runShellCommand(command, directory) {
  return new Promise((resolve, reject) => {
    exec(command, { cwd: directory }, (error, stdout, stderr) => {
      if (error) {
        console.error(`Error: ${error.message}`);
        reject(error);
        return;
      }
      if (stderr) {
        console.error(`Stderr: ${stderr}`);
        reject(stderr);
        return;
      }
      console.log(`Stdout: ${stdout}`);
      resolve(stdout);
    });
  });
}

async function updatePackage(directory) {
  // Updating package.json
  const packageJsonPath = join(directory, "package.json");
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));

  // Updating dependencies
  packageJson.devDependencies = packageJson.devDependencies || {};
  packageJson.devDependencies["@trigger.dev/tsup"] = "workspace:*";
  packageJson.devDependencies["tsup"] = "8.0.1";
  packageJson.devDependencies["typescript"] = "^5.3.0";

  // Updating exports, main, types, and module
  packageJson.exports = {
    ".": {
      import: {
        types: "./dist/index.d.mts",
        default: "./dist/index.mjs",
      },
      require: "./dist/index.js",
      types: "./dist/index.d.ts",
    },
    "./package.json": "./package.json",
  };
  packageJson.main = "./dist/index.js";
  packageJson.types = "./dist/index.d.ts";
  packageJson.module = "./dist/index.mjs";
  packageJson.files = ["dist"];

  await fs.writeFile(
    packageJsonPath,
    await prettier.format(JSON.stringify(packageJson, null, 2), {
      parser: "json",
      ...prettierConfig,
    })
  );

  console.log(`✅ Updated package.json for ${packageJson.name}`);

  // Updating tsconfig.json
  const tsconfigPath = join(directory, "tsconfig.json");
  const tsconfig = JSON.parse(await fs.readFile(tsconfigPath, "utf8"));

  if (tsconfig.extends === "@trigger.dev/tsconfig/integration.json") {
    console.log(
      `✅ tsconfig.json for ${packageJson.name} already extends @trigger.dev/tsconfig/integration.json`
    );
  } else {
    tsconfig.compilerOptions = tsconfig.compilerOptions || {};
    tsconfig.compilerOptions.paths = {
      ...tsconfig.compilerOptions.paths,
      "@trigger.dev/tsup/*": ["../../config-packages/tsup/src/*"],
      "@trigger.dev/tsup": ["../../config-packages/tsup/src/index"],
    };

    await fs.writeFile(
      tsconfigPath,
      await prettier.format(JSON.stringify(tsconfig, null, 2), {
        parser: "json",
        ...prettierConfig,
      })
    );

    console.log(`✅ Updated tsconfig.json for ${packageJson.name}`);
  }

  // Updating tsup.config.ts
  const tsupConfigPath = join(directory, "tsup.config.ts");
  const tsupConfigContent = `import { defineConfigPackage } from "@trigger.dev/tsup";\n\nexport default defineConfigPackage;`;
  await fs.writeFile(
    tsupConfigPath,
    await prettier.format(tsupConfigContent, { parser: "typescript", ...prettierConfig })
  );

  console.log(`✅ Updated tsup.config.ts for ${packageJson.name}`);

  console.log(`✅ Updated package ${packageJson.name}, now running pnpm install and build`);

  await runShellCommand("pnpm install", process.cwd());
  await runShellCommand(`pnpm run build --filter ${packageJson.name}`, process.cwd());
}

async function main() {
  const packagePath = process.argv[2];

  if (!packagePath) {
    throw new Error("Missing package path");
  }

  console.log(`Updating package ${packagePath}`);

  await updatePackage(packagePath);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
