import { $ } from "execa";
import { keyValueBy } from "./keyValueBy";
import { logger } from "./logger";
import { readJSONFileSync } from "./fileSystem";
import { join } from "node:path";

export type ResolveOptions = { allowDev: boolean };

export class JavascriptProject {
  private _packageJson?: any;

  constructor(private projectPath: string) {}

  private get packageJson() {
    if (!this._packageJson) {
      this._packageJson = readJSONFileSync(join(this.projectPath, "package.json"));
    }

    return this._packageJson;
  }

  public get scripts(): Record<string, string> {
    return {
      postinstall: this.packageJson.scripts?.postinstall,
    };
  }

  async resolve(packageName: string, options?: ResolveOptions): Promise<string | undefined> {
    const opts = { allowDev: false, ...options };

    const packageJsonVersion = this.packageJson.dependencies?.[packageName];

    if (typeof packageJsonVersion === "string") {
      return packageJsonVersion;
    }

    if (opts.allowDev) {
      const devPackageJsonVersion = this.packageJson.devDependencies?.[packageName];

      if (typeof devPackageJsonVersion === "string") {
        return devPackageJsonVersion;
      }
    }

    const commands = [new NPMCommands(), new PNPMCommands(), new YarnCommands()];

    for (const command of commands) {
      try {
        const version = await command.resolveDependencyVersion(packageName, {
          cwd: this.projectPath,
        });

        if (version) {
          return version;
        }
      } catch (error) {
        logger.debug(`Failed to resolve dependency version using ${command.name}`, {
          packageName,
          error,
        });
      }
    }
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

type NpmDependency = {
  version: string;
  resolved: string;
  overridden: boolean;
  required?: { version: string };
  dependencies?: Record<string, NpmDependency>;
};

type NpmList = {
  dependencies: Record<string, NpmDependency>;
};

type PackageManagerOptions = {
  cwd?: string;
};

interface PackageManagerCommands {
  resolveDependencyVersion(
    packageName: string,
    options: PackageManagerOptions
  ): Promise<string | undefined>;
}

class PNPMCommands implements PackageManagerCommands {
  get name() {
    return "pnpm";
  }

  async resolveDependencyVersion(
    packageName: string,
    options: PackageManagerOptions
  ): Promise<string | undefined> {
    const cmd = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
    const { stdout } = await $({ cwd: options.cwd })`${cmd} list ${packageName} -r --json`;
    const result = JSON.parse(stdout) as PnpmList;

    // Return the first dependency version that matches the package name
    for (const dep of result) {
      const dependency = dep.dependencies?.[packageName];

      if (dependency) {
        return dependency.version;
      }
    }
  }
}

class NPMCommands implements PackageManagerCommands {
  get name() {
    return "npm";
  }

  async list(options: PackageManagerOptions): Promise<Record<string, string | undefined>> {
    const cmd = process.platform === "win32" ? "npm.cmd" : "npm";

    const { stdout } = await $({ cwd: options.cwd })`${cmd} ls --depth=0 --json`;

    const dependencies = (JSON.parse(stdout) as NpmList).dependencies;

    return keyValueBy(dependencies, (name, info) => ({
      // unmet peer dependencies have a different structure
      [name]: info.version || info.required?.version,
    }));
  }

  async resolveDependencyVersion(
    packageName: string,
    options: PackageManagerOptions
  ): Promise<string | undefined> {
    const cmd = process.platform === "win32" ? "npm.cmd" : "npm";
    const { stdout } = await $({ cwd: options.cwd })`${cmd} show ${packageName} version`;

    return stdout.trim();
  }
}

class YarnCommands implements PackageManagerCommands {
  get name() {
    return "yarn";
  }

  async resolveDependencyVersion(
    packageName: string,
    options: PackageManagerOptions
  ): Promise<string | undefined> {
    const cmd = process.platform === "win32" ? "yarn.cmd" : "yarn";

    const { stdout } = await $({ cwd: options.cwd })`${cmd} info ${packageName} --json`;

    const lines = stdout.split("\n");

    for (const line of lines) {
      const json = JSON.parse(line);

      if (json.value === packageName) {
        return json.children.Version;
      }
    }
  }
}
