import { getUserPackageManager } from "../getUserPkgManager";
import spawn from "spawn-please";
import { keyValueBy } from "../keyValueBy";
import nodeSemver from "semver";
import jsonlines from "jsonlines";

export async function listPackageDependencies(
  path: string,
  tag: string | undefined = undefined
): Promise<Record<string, string | undefined>> {
  const packageManager = await getPackageManagerCommands(path);

  const list = await packageManager.list({ cwd: path });

  return Object.keys(list).reduce(
    (acc, dependency) => {
      const version = list[dependency];

      if (!version) {
        return acc;
      }

      if (dependency.startsWith("@trigger.dev/") && version.startsWith("link:")) {
        acc[dependency] = tag ?? "latest";
      } else {
        acc[dependency] = version;
      }

      return acc;
    },
    {} as Record<string, string | undefined>
  );
}

type PnpmList = {
  path: string;
  private: boolean;
  dependencies: Record<
    string,
    {
      from: string;
      version: string;
      resolved: string;
    }
  >;
}[];

async function getPackageManagerCommands(path: string): Promise<PackageManagerCommands> {
  const packageManager = await getUserPackageManager(path);

  switch (packageManager) {
    case "npm":
      return new NPMCommands();
    case "pnpm":
      return new PNPMCommands();
    case "yarn":
      return new YarnCommands();
  }
}

type ListOptions = {
  cwd?: string;
  prefix?: string;
  global?: boolean;
};

interface PackageManagerCommands {
  list(options: ListOptions): Promise<Record<string, string | undefined>>;
}

class PNPMCommands implements PackageManagerCommands {
  async list(options: ListOptions): Promise<Record<string, string | undefined>> {
    const cmd = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
    const listOutput = await spawn(cmd, ["ls", "--depth", "1", "--json", "--long"], options);
    const result = JSON.parse(listOutput) as PnpmList;

    const list = keyValueBy(result[0]?.dependencies ?? {}, (name, { version }) => ({
      [name]: version,
    }));

    return list;
  }
}

type NpmOptions = {
  location?: string;
  prefix?: string;
  registry?: string;
};

class NPMCommands implements PackageManagerCommands {
  async list(options: ListOptions): Promise<Record<string, string | undefined>> {
    const result = await this.#spawn(
      ["ls", "--depth=0"],
      {
        ...(options.prefix ? { prefix: options.prefix } : null),
      },
      {
        ...(options.cwd ? { cwd: options.cwd } : null),
        rejectOnError: false,
      }
    );

    const dependencies = this.#parseJson<{
      dependencies: Record<string, { version?: string; required?: { version: string } }>;
    }>(result, {
      command: `npm${process.platform === "win32" ? ".cmd" : ""} ls --json${
        options.global ? " --location=global" : ""
      }${options.prefix ? " --prefix " + options.prefix : ""}`,
    }).dependencies;

    return keyValueBy(dependencies, (name, info) => ({
      // unmet peer dependencies have a different structure
      [name]: info.version || info.required?.version,
    }));
  }

  /**
   * Spawns npm with --json. Handles different commands for Window and Linux/OSX, and automatically converts --location=global to --global on node < 8.11.0.
   *
   * @param args
   * @param [npmOptions={}]
   * @param [spawnOptions={}]
   * @returns
   */
  async #spawn(
    args: string | string[],
    npmOptions: NpmOptions = {},
    spawnOptions: Record<string, any> = {}
  ): Promise<any> {
    const cmd = process.platform === "win32" ? "npm.cmd" : "npm";
    args = Array.isArray(args) ? args : [args];

    const fullArgs = args.concat(
      npmOptions.location
        ? (await this.#isGlobalDeprecated())
          ? `--location=${npmOptions.location}`
          : npmOptions.location === "global"
          ? "--global"
          : ""
        : [],
      npmOptions.prefix ? `--prefix=${npmOptions.prefix}` : [],
      "--json"
    );

    return spawn(cmd, fullArgs, spawnOptions);
  }

  async #isGlobalDeprecated() {
    const cmd = process.platform === "win32" ? "npm.cmd" : "npm";
    const output = await spawn(cmd, ["--version"]);
    const npmVersion = output.trim();
    // --global was deprecated in npm v8.11.0.
    return nodeSemver.valid(npmVersion) && nodeSemver.gte(npmVersion, "8.11.0");
  }

  /**
   * Parse JSON and throw an informative error on failure.
   *
   * @param result Data to be parsed
   * @param data
   * @returns
   */
  #parseJson<R>(result: string, data: { command?: string; packageName?: string }): R {
    let json;
    try {
      json = JSON.parse(result);
    } catch (err) {
      throw new Error(
        `Expected JSON from "${data.command}".${
          data.packageName ? ` There could be problems with the ${data.packageName} package.` : ""
        } ${result ? "Instead received: " + result : "Received empty response."}`
      );
    }
    return json as R;
  }
}

interface YarnParsedDep {
  version: string;
  from: string;
  required?: {
    version: string;
  };
}

class YarnCommands implements PackageManagerCommands {
  async list(options: ListOptions): Promise<Record<string, string | undefined>> {
    const jsonLines: string = await this.#spawn("list", options as Record<string, string>, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
    });

    const json: { dependencies: Record<string, YarnParsedDep> } = await this.#parseJsonLines(
      jsonLines
    );

    const keyValues: Record<string, string | undefined> = keyValueBy<
      YarnParsedDep,
      string | undefined
    >(json.dependencies, (name, info): { [key: string]: string | undefined } => ({
      // unmet peer dependencies have a different structure
      [name]: info.version || info.required?.version,
    }));

    return keyValues;
  }

  /**
   * Spawn yarn requires a different command on Windows.
   *
   * @param args
   * @param [yarnOptions={}]
   * @param [spawnOptions={}]
   * @returns
   */
  async #spawn(
    args: string | string[],
    yarnOptions: NpmOptions = {},
    spawnOptions?: any
  ): Promise<string> {
    const cmd = process.platform === "win32" ? "yarn.cmd" : "yarn";

    const fullArgs = [
      ...(yarnOptions.location === "global" ? "global" : []),
      ...(Array.isArray(args) ? args : [args]),
      "--depth=0",
      ...(yarnOptions.prefix ? `--prefix=${yarnOptions.prefix}` : []),
      "--json",
      "--no-progress",
    ];

    return spawn(cmd, fullArgs, spawnOptions);
  }

  /**
   * Parse JSON lines and throw an informative error on failure.
   *
   * Note: although this is similar to the NPM parseJson() function we always return the
   * same concrete-type here, for now.
   *
   * @param result    Output from `yarn list --json` to be parsed
   */
  #parseJsonLines(result: string): Promise<{ dependencies: Record<string, YarnParsedDep> }> {
    return new Promise((resolve, reject) => {
      const dependencies: Record<string, YarnParsedDep> = {};

      const parser = jsonlines.parse();

      parser.on("data", (d) => {
        // only parse info data
        // ignore error info, e.g. "Visit https://yarnpkg.com/en/docs/cli/list for documentation about this command."
        if (d.type === "info" && !d.data.match(/^Visit/)) {
          // parse package name and version number from info data, e.g. "nodemon@2.0.4" has binaries
          const [, pkgName, pkgVersion] = d.data.match(/"(@?.*)@(.*)"/) || [];

          dependencies[pkgName] = {
            version: pkgVersion,
            from: pkgName,
          };
        } else if (d.type === "error") {
          reject(new Error(d.data));
        }
      });

      parser.on("end", () => {
        resolve({ dependencies });
      });

      parser.on("error", reject);

      parser.write(result);

      parser.end();
    });
  }
}
