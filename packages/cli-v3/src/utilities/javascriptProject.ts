import { $ } from "execa";
import { join } from "node:path";
import { readJSONFileSync } from "./fileSystem";
import { logger } from "./logger";
import { PackageManager, getUserPackageManager } from "./getUserPackageManager";
import { PackageJson } from "type-fest";
import { assertExhaustive } from "./assertExhaustive";

export type ResolveOptions = { allowDev: boolean };

const BuiltInModules = new Set([
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "dns",
  "domain",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "repl",
  "stream",
  "string_decoder",
  "timers",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "worker_threads",
  "zlib",
]);

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

  public get scripts(): Record<string, string> {
    return {
      postinstall: this.packageJson.scripts?.postinstall ?? "",
    };
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

  async resolve(packageName: string, options?: ResolveOptions): Promise<string | undefined> {
    if (BuiltInModules.has(packageName)) {
      return undefined;
    }

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

    const command = await this.#getCommand();

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

  resolveDependencyVersion(
    packageName: string,
    options: PackageManagerOptions
  ): Promise<string | undefined>;
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

  async resolveDependencyVersion(packageName: string, options: PackageManagerOptions) {
    const { stdout } = await $({ cwd: options.cwd })`${this.cmd} list ${packageName} -r --json`;
    const result = JSON.parse(stdout) as PnpmList;

    logger.debug(`Resolving ${packageName} version using ${this.name}`, { result });

    // Return the first dependency version that matches the package name
    for (const dep of result) {
      const dependency = dep.dependencies?.[packageName];

      if (dependency) {
        return dependency.version;
      }
    }
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

  async resolveDependencyVersion(packageName: string, options: PackageManagerOptions) {
    const { stdout } = await $({ cwd: options.cwd })`${this.cmd} list ${packageName} --json`;
    const output = JSON.parse(stdout) as NpmListOutput;

    logger.debug(`Resolving ${packageName} version using ${this.name}`, { output });

    return this.#recursivelySearchDependencies(output.dependencies, packageName);
  }

  #recursivelySearchDependencies(
    dependencies: Record<string, NpmDependency>,
    packageName: string
  ): string | undefined {
    for (const [name, dependency] of Object.entries(dependencies)) {
      if (name === packageName) {
        return dependency.version;
      }

      if (dependency.dependencies) {
        const result = this.#recursivelySearchDependencies(dependency.dependencies, packageName);

        if (result) {
          return result;
        }
      }
    }
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

  async resolveDependencyVersion(packageName: string, options: PackageManagerOptions) {
    const { stdout } = await $({ cwd: options.cwd })`${this.cmd} info ${packageName} --json`;

    const lines = stdout.split("\n");

    logger.debug(`Resolving ${packageName} version using ${this.name}`, { lines });

    for (const line of lines) {
      const json = JSON.parse(line);

      if (json.value === packageName) {
        return json.children.Version;
      }
    }
  }
}
