import { BuildExtension } from "@trigger.dev/core/v3/build";
import { dirname } from "node:path";
import { readPackageJSON } from "pkg-types";

export type AdditionalPackagesOptions = {
  packages: string[];
};

/**
 * Add additional packages to the build when deploying, useful when you are using the bin command of a package by shelling out to it.
 * You can pass the name of the package, and it's version will be resolved from the locally installed version. If the version cannot be automatically resolved, it will resolve to the latest version, or you can specify the version using `@` syntax.
 * @example
 *
 * ```ts
 * additionalPackages({
 *  packages: ["wrangler", "prisma@3.0.0"]
 * });
 */
export function additionalPackages(options: AdditionalPackagesOptions): BuildExtension {
  return {
    name: "additionalPackages",
    async onBuildStart(context) {
      if (context.target !== "deploy") {
        return;
      }

      const dependencies: Record<string, string> = {};

      for (const pkg of options.packages) {
        const { name, version } = parsePackageName(pkg);

        if (version) {
          dependencies[name] = version;
        } else {
          try {
            // Lets try and resolve the version from the local package.json
            const modulePath = await context.resolvePath(name);

            if (!modulePath) {
              dependencies[name] = "latest";
              continue;
            }

            context.logger.debug("[additionalPackages] Resolved module path", { modulePath });

            const packageJSON = await readPackageJSON(dirname(modulePath));

            if (packageJSON.version) {
              dependencies[name] = packageJSON.version;
            } else {
              context.logger.warn(
                `Could not resolve version for package ${name}, defaulting to latest`
              );

              dependencies[name] = "latest";
            }
          } catch (error) {
            console.warn(
              `Could not resolve version for package ${name}, defaulting to latest`,
              error
            );

            dependencies[name] = "latest";
          }
        }
      }

      context.addLayer({
        id: "additionalPackages",
        dependencies,
      });
    },
  };
}

// This needs to handle packages like @taskhero/config@1.0.0, wrangler, wrangler@1.0.0, @taskhero/config, etc.
function parsePackageName(pkg: string): {
  name: string;
  version?: string;
} {
  // Regular expression to match package names and versions
  const regex = /^(@?[a-z0-9-~][a-z0-9-._~]*\/)?([a-z0-9-~][a-z0-9-._~]*)(@(.+))?$/i;
  const match = pkg.match(regex);

  if (!match) {
    throw new Error(`Invalid package name: ${pkg}`);
  }

  const [, scope, packageName, , version] = match;

  if (!packageName) {
    throw new Error(`Invalid package name: ${pkg}`);
  }

  return {
    name: scope ? `${scope}${packageName}` : packageName,
    version,
  };
}
