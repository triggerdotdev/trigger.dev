import { $ } from "execa";
import jsonlines from "jsonlines";
import { getUserPackageManager } from "./getUserPackageManager";
import { keyValueBy } from "./keyValueBy";

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
};

interface PackageManagerCommands {
  list(options: ListOptions): Promise<Record<string, string | undefined>>;
}

class PNPMCommands implements PackageManagerCommands {
  async list(options: ListOptions): Promise<Record<string, string | undefined>> {
    const cmd = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
    const { stdout } = await $({ cwd: options.cwd })`${cmd} ls --depth 1 --json --long`;
    const result = JSON.parse(stdout) as PnpmList;

    const list = keyValueBy(result[0]?.dependencies ?? {}, (name, { version }) => ({
      [name]: version,
    }));

    return list;
  }
}

class NPMCommands implements PackageManagerCommands {
  async list(options: ListOptions): Promise<Record<string, string | undefined>> {
    const cmd = process.platform === "win32" ? "npm.cmd" : "npm";

    const { stdout } = await $({ cwd: options.cwd })`${cmd} ls --depth=0 --json`;

    const dependencies = (
      JSON.parse(stdout) as {
        dependencies: Record<string, { version?: string; required?: { version: string } }>;
      }
    ).dependencies;

    return keyValueBy(dependencies, (name, info) => ({
      // unmet peer dependencies have a different structure
      [name]: info.version || info.required?.version,
    }));
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
    const cmd = process.platform === "win32" ? "yarn.cmd" : "yarn";

    const { stdout } = await $`${cmd} list --depth=0 --json --no-progress`;

    const json: { dependencies: Record<string, YarnParsedDep> } = await this.#parseJsonLines(
      stdout
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
