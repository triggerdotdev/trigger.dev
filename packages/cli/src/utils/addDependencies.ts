import chalk from "chalk";
import { execa } from "execa";
import ora, { type Ora } from "ora";
import pathModule from "path";
import { getUserPackageManager, type PackageManager } from "./getUserPkgManager";
import fs from "fs/promises";
import fetch from "./fetchUseProxy";
import { z } from "zod";

export type InstallPackage = {
  name: string;
  tag: string;
};

export type InstalledPackage = {
  name: string;
  version: string;
};

export async function addDependencies(projectDir: string, packages: Array<InstallPackage>) {
  const pkgManager = await getUserPackageManager(projectDir);

  const spinner = ora("Adding @trigger.dev dependencies to package.json...").start();

  const installedPackages = await addDependenciesToPackageJson(projectDir, packages);

  spinner.succeed(
    chalk.green(
      `Successfully added dependencies to package.json: ${installedPackages
        .map((pkg) => `${pkg.name}@${pkg.version}`)
        .join(", ")}`
    )
  );

  const installSpinner = await runInstallCommand(pkgManager, projectDir);

  (installSpinner || ora()).stop();
}

async function addDependenciesToPackageJson(
  projectDir: string,
  packages: Array<InstallPackage>
): Promise<Array<InstalledPackage>> {
  const pkgJsonPath = pathModule.join(projectDir, "package.json");
  const pkgBuffer = await fs.readFile(pkgJsonPath);
  const pkgJson = JSON.parse(pkgBuffer.toString());

  const packagesToInstall = await getLatestPackageVersions(packages);

  // Add the dependencies to the package.json file
  pkgJson.dependencies = {
    ...pkgJson.dependencies,
    ...Object.fromEntries(packagesToInstall.map((pkg) => [pkg.name, `^${pkg.version}`])),
  };

  // Write the updated package.json file
  await fs.writeFile(pkgJsonPath, JSON.stringify(pkgJson, null, 2));

  return packagesToInstall;
}

const PackageSchema = z.object({
  name: z.string(),
  "dist-tags": z.record(z.string()),
});

export async function getLatestPackageVersion(
  packageName: string,
  tag: string
): Promise<InstalledPackage | undefined> {
  const response = await fetch(`https://registry.npmjs.org/${packageName}`);

  if (!response.ok) {
    return;
  }

  const body = await response.json();

  const parsedBody = PackageSchema.safeParse(body);

  if (!parsedBody.success) {
    return;
  }

  const latestVersion = parsedBody.data["dist-tags"][tag];

  if (!latestVersion) {
    return;
  }

  return {
    name: packageName,
    version: latestVersion,
  };
}

async function getLatestPackageVersions(
  packages: Array<InstallPackage>
): Promise<Array<InstalledPackage>> {
  const latestPackageVersions = await Promise.all(
    packages.map((pkg) => getLatestPackageVersion(pkg.name, pkg.tag))
  );

  return latestPackageVersions.filter(Boolean) as Array<InstalledPackage>;
}

async function runInstallCommand(
  pkgManager: PackageManager,
  projectDir: string
): Promise<Ora | null> {
  switch (pkgManager) {
    // When using npm, inherit the stderr stream so that the progress bar is shown
    case "npm":
      await execa(pkgManager, ["install"], {
        cwd: projectDir,
        stderr: "inherit",
      });

      return null;
    // When using yarn or pnpm, use the stdout stream and ora spinner to show the progress
    case "pnpm":
      const pnpmSpinner = ora("Running pnpm install...").start();
      const pnpmSubprocess = execa(pkgManager, ["install"], {
        cwd: projectDir,
        stdout: "pipe",
      });

      await new Promise<void>((res, rej) => {
        pnpmSubprocess.stdout?.on("data", (data: Buffer) => {
          const text = data.toString();

          if (text.includes("Progress")) {
            pnpmSpinner.text = text.includes("|") ? text.split(" | ")[1] ?? "" : text;
          }
        });
        pnpmSubprocess.on("error", (e) => rej(e));
        pnpmSubprocess.on("close", () => res());
      });

      return pnpmSpinner;
    case "yarn":
      const yarnSpinner = ora("Running yarn...").start();
      const yarnSubprocess = execa(pkgManager, [], {
        cwd: projectDir,
        stdout: "pipe",
      });

      await new Promise<void>((res, rej) => {
        yarnSubprocess.stdout?.on("data", (data: Buffer) => {
          yarnSpinner.text = data.toString();
        });
        yarnSubprocess.on("error", (e) => rej(e));
        yarnSubprocess.on("close", () => res());
      });

      return yarnSpinner;
  }
}
