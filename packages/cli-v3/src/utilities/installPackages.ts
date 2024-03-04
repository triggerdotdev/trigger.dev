import semver from "semver";
import { execa } from "execa";
import { logger } from "./logger";
import { join } from "node:path";
import { readJSONFile } from "./fileSystem";

export type InstallPackagesOptions = { cwd?: string };

export async function installPackages(
  packages: Record<string, string>,
  options?: InstallPackagesOptions
) {
  const cwd = options?.cwd ?? process.cwd();

  // Make sure the cwd has a package.json file (if not create a barebones one)
  try {
    await readJSONFile(join(cwd, "package.json"));
  } catch (error) {
    await execa("npm", ["init", "-y"], { cwd });
  }

  // Detect with packages have already been installed at the specified version (use semver to compare)
  // and only install the ones that are missing or have a different version
  const installablePackages = await Promise.all(
    Object.entries(packages).map(async ([name, version]) => {
      try {
        const latestVersion = await getPackageVersion(join(cwd, "node_modules", name));

        if (!latestVersion) {
          return { name, version };
        }

        return semver.satisfies(latestVersion, version) ? undefined : { name, version };
      } catch (error) {
        return { name, version };
      }
    })
  )
    .then((packages) => packages.filter(Boolean))
    .then((packages) =>
      packages.reduce((acc: Record<string, string>, p) => ({ ...acc, [p!.name]: p!.version }), {})
    );

  if (Object.keys(installablePackages).length === 0) {
    return;
  }

  logger.debug(`Installing packages at ${cwd}:`);
  logger.table(
    Object.entries(installablePackages).map(([name, version]) => ({ name, version })),
    "debug"
  );

  const childProcess = execa(
    "npm",
    [
      "install",
      ...Object.entries(installablePackages).map(([name, version]) => `${name}@${version}`),
      "--install-strategy",
      "nested",
      "--ignore-scripts",
      "--no-package-lock",
      "--no-audit",
      "--no-fund",
      "--no-save",
    ],
    {
      cwd,
      stderr: "inherit",
    }
  );

  await new Promise<void>((res, rej) => {
    childProcess.on("error", (e) => rej(e));
    childProcess.on("close", () => res());
  });

  await childProcess;

  return;
}

async function getPackageVersion(path: string) {
  try {
    const packageJsonPath = join(path, "package.json");
    const packageJson = await readJSONFile(packageJsonPath);

    return packageJson.version;
  } catch (error) {
    return undefined;
  }
}
