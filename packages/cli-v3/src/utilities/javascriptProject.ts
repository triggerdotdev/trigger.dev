import { $ } from "execa";
import { join } from "node:path";
import { readJSONFileSync } from "./fileSystem";
import { logger } from "./logger";
import { PackageManager, getUserPackageManager } from "./getUserPackageManager";
import { PackageJson } from "type-fest";
import { assertExhaustive } from "./assertExhaustive";
import { tracer } from "../cli/common";
import { recordSpanException } from "@trigger.dev/core/v3/otel";
import { flattenAttributes } from "@trigger.dev/core/v3";

export type DependencyMeta = { version: string; external: boolean };

export class JavascriptProject {
  private _packageJson?: PackageJson;
  private _packageManager?: PackageManager;

  constructor(private projectPath: string) {}

  private get packageJson() {
    if (!this._packageJson) {
      this._packageJson = readJSONFileSync(join(this.projectPath, "package.json")) as PackageJson;
    }

    return this._packageJson;
  }

  public get allowedPackageJson(): Record<string, unknown> {
    const disallowedKeys = [
      "scripts",
      "devDependencies",
      "dependencies",
      "peerDependencies",
      "author",
      "contributors",
      "funding",
      "bugs",
      "files",
      "keywords",
      "main",
      "module",
      "type",
      "bin",
      "browser",
      "man",
      "directories",
      "repository",
      "peerDependenciesMeta",
      "optionalDependencies",
      "engines",
      "os",
      "cpu",
      "private",
      "publishConfig",
      "workspaces",
    ];

    return Object.keys(this.packageJson).reduce(
      (acc, key) => {
        if (!disallowedKeys.includes(key)) {
          acc[key] = this.packageJson[key];
        }

        return acc;
      },
      {} as Record<string, unknown>
    );
  }

  public get scripts(): Record<string, string> {
    return this.#filterScripts();
  }

  #filterScripts(): Record<string, string> {
    if (!this.packageJson.scripts || typeof this.packageJson.scripts !== "object") {
      return {};
    }

    return this.packageJson.scripts as Record<string, string>;
  }

  async install(): Promise<void> {
    const command = await this.#getCommand();

    try {
      await command.installDependencies({
        cwd: this.projectPath,
      });
    } catch (error) {
      logger.debug(`Failed to install dependencies using ${command.name}`, {
        error,
      });
    }
  }

  async extractDirectDependenciesMeta(): Promise<Record<string, DependencyMeta>> {
    return tracer.startActiveSpan(
      "JavascriptProject.extractDirectDependenciesMeta",
      async (span) => {
        const command = await this.#getCommand();

        span.setAttributes({
          packageManager: command.name,
        });

        try {
          const packagesMeta = await command.extractDirectDependenciesMeta({
            cwd: this.projectPath,
          });

          // Merge the resolved versions with the package.json dependencies
          const missingPackagesMeta = Object.entries(packagesMeta).filter(
            ([, { version }]) => !version
          );
          const missingPackageVersions: Record<string, string> = {};

          for (const [packageName, { external }] of missingPackagesMeta) {
            const packageJsonVersion = this.packageJson.dependencies?.[packageName];

            if (typeof packageJsonVersion === "string") {
              logger.debug(`Resolved ${packageName} version using package.json`, {
                packageJsonVersion,
              });

              packagesMeta[packageName] = { version: packageJsonVersion, external };
              missingPackageVersions[packageName] = packageJsonVersion;
            } else {
              // Last resort: check devDependencies
              const devPackageJsonVersion = this.packageJson.devDependencies?.[packageName];

              if (typeof devPackageJsonVersion === "string") {
                logger.debug(`Resolved ${packageName} version using devDependencies`, {
                  devPackageJsonVersion,
                });

                packagesMeta[packageName] = { version: devPackageJsonVersion, external };
                missingPackageVersions[packageName] = devPackageJsonVersion;
              }
            }
          }

          span.setAttributes({
            ...flattenAttributes(missingPackageVersions, "missingPackageVersions"),
            missingPackages: missingPackagesMeta.map(
              ([packageName]: [string, DependencyMeta]) => packageName
            ),
          });

          span.end();

          return packagesMeta;
        } catch (error) {
          recordSpanException(span, error);
          span.end();

          logger.debug(`Failed to resolve internal dependencies using ${command.name}`, {
            error,
          });

          throw error;
        }
      }
    );
  }

  async #getCommand(): Promise<PackageManagerCommands> {
    const packageManager = await this.getPackageManager();

    switch (packageManager) {
      case "npm":
        return new NPMCommands();
      case "pnpm":
        return new PNPMCommands();
      case "yarn":
        return new YarnCommands();
      default:
        assertExhaustive(packageManager);
    }
  }

  async getPackageManager(): Promise<PackageManager> {
    if (!this._packageManager) {
      this._packageManager = await getUserPackageManager(this.projectPath);
    }

    return this._packageManager;
  }
}

type PnpmList = {
  name: string;
  path: string;
  version: string;
  private: boolean;
  dependencies?: Record<
    string,
    {
      from: string;
      version: string;
      resolved: string;
      path: string;
    }
  >;
}[];

type PackageManagerOptions = {
  cwd?: string;
};

interface PackageManagerCommands {
  name: string;

  installDependencies(options: PackageManagerOptions): Promise<void>;

  extractDirectDependenciesMeta(
    options: PackageManagerOptions
  ): Promise<Record<string, DependencyMeta>>;
}

class PNPMCommands implements PackageManagerCommands {
  get name() {
    return "pnpm";
  }

  private get cmd() {
    return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  }

  async installDependencies(options: PackageManagerOptions) {
    const { stdout, stderr } = await $({ cwd: options.cwd })`${this.cmd} install`;

    logger.debug(`Installing dependencies using ${this.name}`, { stdout, stderr });
  }

  async extractDirectDependenciesMeta(options: PackageManagerOptions) {
    const result = await this.#listDirectDependencies(options);

    logger.debug(`Extracting direct dependencies metadata using ${this.name}`);

    const results: Record<string, DependencyMeta> = {};

    for (const projectPkg of result) {
      results[projectPkg.name] = { version: projectPkg.version, external: false };

      if (projectPkg.dependencies) {
        for (const [name, dep] of Object.entries(projectPkg.dependencies)) {
          const { version } = dep;

          results[name] = {
            version,
            external: !version.startsWith("link:"),
          };
        }
      }
    }

    return results;
  }

  async #listDirectDependencies(options: PackageManagerOptions) {
    const childProcess = await $({
      cwd: options.cwd,
      reject: false,
    })`${this.cmd} list --recursive --json`;

    if (childProcess.failed) {
      logger.debug("Failed to list dependencies, using stdout anyway...", {
        error: childProcess,
      });
    }

    return JSON.parse(childProcess.stdout) as PnpmList;
  }
}

type NpmDependency = {
  version: string;
  resolved: string;
  overridden: boolean;
  required?: { version: string };
  dependencies?: Record<string, NpmDependency>;
};

type NpmListOutput = {
  dependencies: Record<string, NpmDependency>;
};

class NPMCommands implements PackageManagerCommands {
  get name() {
    return "npm";
  }

  private get cmd() {
    return process.platform === "win32" ? "npm.cmd" : "npm";
  }

  async installDependencies(options: PackageManagerOptions) {
    const { stdout, stderr } = await $({ cwd: options.cwd })`${this.cmd} install`;

    logger.debug(`Installing dependencies using ${this.name}`, { stdout, stderr });
  }

  async extractDirectDependenciesMeta(
    options: PackageManagerOptions
  ): Promise<Record<string, DependencyMeta>> {
    const result = await this.#listDirectDependencies(options);

    logger.debug(`Extracting direct dependencies metadata using ${this.name}`);

    return result.dependencies ? this.#flattenDependenciesMeta(result.dependencies) : {};
  }

  async #listDirectDependencies(options: PackageManagerOptions) {
    const childProcess = await $({
      cwd: options.cwd,
      reject: false,
    })`${this.cmd} list --json`;

    if (childProcess.failed) {
      logger.debug("Failed to list dependencies, using stdout anyway...", {
        error: childProcess,
      });
    }

    return JSON.parse(childProcess.stdout) as NpmListOutput;
  }

  #flattenDependenciesMeta(
    dependencies: Record<string, NpmDependency>
  ): Record<string, DependencyMeta> {
    let results: Record<string, DependencyMeta> = {};

    for (const [name, dep] of Object.entries(dependencies)) {
      const { version, resolved, dependencies: children } = dep;
      results[name] = { version, external: !!resolved && !resolved.startsWith("file:") };

      if (children) {
        results = { ...results, ...this.#flattenDependenciesMeta(children) };
      }
    }

    return results;
  }
}

class YarnCommands implements PackageManagerCommands {
  get name() {
    return "yarn";
  }

  private get cmd() {
    return process.platform === "win32" ? "yarn.cmd" : "yarn";
  }

  async installDependencies(options: PackageManagerOptions) {
    const { stdout, stderr } = await $({ cwd: options.cwd })`${this.cmd} install`;

    logger.debug(`Installing dependencies using ${this.name}`, { stdout, stderr });
  }

  async extractDirectDependenciesMeta(options: PackageManagerOptions) {
    const result = await this.#listDirectDependencies(options);

    const rawPackagesData = result.split("\n");
    logger.debug(`Extracting direct dependencies metadata using ${this.name}`);

    const results: Record<string, DependencyMeta> = {};

    for (const rawPackageData of rawPackagesData) {
      const packageData = JSON.parse(rawPackageData);

      const [name, dependencyMeta] = this.#parseYarnValueIntoDependencyMeta(packageData.value);
      results[name] = dependencyMeta;
    }

    return results;
  }

  async #listDirectDependencies(options: PackageManagerOptions) {
    const childProcess = await $({
      cwd: options.cwd,
      reject: false,
    })`${this.cmd} info --all --json`;

    if (childProcess.failed) {
      logger.debug("Failed to list dependencies, using stdout anyway...", {
        error: childProcess,
      });
    }

    return childProcess.stdout;
  }

  // The "value" when doing yarn info is formatted like this:
  // "package-name@npm:version" or "package-name@workspace:version"
  // This function will parse the value into just the package name.
  // This correctly handles scoped packages as well e.g. @scope/package-name@npm:version
  #parseYarnValueIntoDependencyMeta(value: string): [string, DependencyMeta] {
    const parts = value.split("@");
    let name: string, protocol: string, version: string;

    if (parts.length === 3) {
      // e.g. @<scope>/<package>@<protocol>:<version> -> ["", "<scope>/<package>"", "<protocol>:<version>""]
      name = `@${parts[1]}`;
      [protocol = "", version = ""] = parts[2]!.split(":");
    } else if (parts.length === 2) {
      // e.g. <package>@<protocol>:<version> -> ["<package>"", "<protocol>:<version>""]
      name = parts[0]!.toString();
      [protocol = "", version = ""] = parts[1]!.split(":");
    } else {
      throw new Error("Failed parsing ${value} into dependency meta");
    }

    return [
      name,
      {
        version,
        external: protocol !== "workspace" && protocol !== "file",
      },
    ];
  }
}
