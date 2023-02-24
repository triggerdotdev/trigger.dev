import path from "node:path";
import degit from "degit";
import ora from "ora";
import chalk from "chalk";
import fs from "fs-extra";
import { logger } from "./logger.js";

export async function createProject(
  repositoryRef: string,
  projectDir: string,
  projectName: string
) {
  const emitter = degit(repositoryRef);

  emitter.on("info", (info) => {
    console.log(info.message);
  });

  emitter.on("warn", (warning) => {
    console.warn(warning.message);
  });

  const projectPath = path.resolve(process.cwd(), projectDir);

  // If the project directory already exists, log an error and exit
  if (fs.existsSync(projectPath)) {
    logger.error(`A directory already exists at: ${projectPath}`);
    return;
  }

  const spinner = ora(
    `Copying ${repositoryRef} to: ${projectDir}...\n`
  ).start();

  spinner.start();

  await emitter.clone(projectPath);

  // Rewrite the package.json file to use the new project name
  updatePackageJson(projectName, projectPath);
  // Rewrite the README.md file to use the new project name
  updateReadme(projectName, projectPath);
  // Remove package-lock.json
  fs.removeSync(path.resolve(projectPath, "package-lock.json"));
  // Remove .env.example
  fs.removeSync(path.resolve(projectPath, ".env.example"));

  spinner.succeed(
    `${chalk.cyan.bold(projectName)} ${chalk.green("copied successfully!")}\n`
  );

  return projectDir;
}

function updatePackageJson(projectName: string, projectDir: string) {
  const existingPackageJson = fs.readJSONSync(
    path.resolve(projectDir, "package.json")
  );

  const newPackageJson = {
    ...existingPackageJson,
    name: projectName,
  };

  fs.writeJSONSync(path.resolve(projectDir, "package.json"), newPackageJson, {
    spaces: 2,
  });
}

function updateReadme(projectName: string, projectDir: string) {
  const existingReadme = fs.readFileSync(path.resolve(projectDir, "README.md"));

  fs.writeFileSync(path.resolve(projectDir, "README.md"), existingReadme);
}
