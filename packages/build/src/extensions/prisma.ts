import { BuildManifest, BuildTarget } from "@trigger.dev/core/v3";
import { binaryForRuntime, BuildContext, BuildExtension } from "@trigger.dev/core/v3/build";
import assert from "node:assert";
import { existsSync } from "node:fs";
import { cp, readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { readPackageJSON, resolvePackageJSON } from "pkg-types";

export type PrismaExtensionOptions = {
  schema: string;
  migrate?: boolean;
  version?: string;
  /**
   * Adds the `--sql` flag to the `prisma generate` command. This will generate the SQL files for the Prisma schema. Requires the `typedSql preview feature and prisma 5.19.0 or later.
   */
  typedSql?: boolean;
  /**
   * The client generator to use. Set this param to prevent all generators in the prisma schema from being generated.
   *
   * @example
   *
   * ### Prisma schema
   *
   * ```prisma
   * generator client {
   *  provider = "prisma-client-js"
   * }
   *
   * generator typegraphql {
   *  provider = "typegraphql-prisma"
   *  output = "./generated/type-graphql"
   * }
   * ```
   *
   * ### PrismaExtension
   *
   * ```ts
   * prismaExtension({
   *  schema: "./prisma/schema.prisma",
   *  clientGenerator: "client"
   * });
   * ```
   */
  clientGenerator?: string;
  directUrlEnvVarName?: string;
};

const BINARY_TARGET = "linux-arm64-openssl-3.0.x";

export function prismaExtension(options: PrismaExtensionOptions): PrismaExtension {
  return new PrismaExtension(options);
}

export class PrismaExtension implements BuildExtension {
  moduleExternals: string[];

  public readonly name = "PrismaExtension";

  private _resolvedSchemaPath?: string;

  constructor(private options: PrismaExtensionOptions) {
    this.moduleExternals = ["@prisma/client", "@prisma/engines"];
  }

  externalsForTarget(target: BuildTarget) {
    if (target === "dev") {
      return [];
    }

    return this.moduleExternals;
  }

  async onBuildStart(context: BuildContext) {
    if (context.target === "dev") {
      return;
    }

    // Resolve the path to the prisma schema, relative to the config.directory
    this._resolvedSchemaPath = resolve(context.workingDir, this.options.schema);

    context.logger.debug(`Resolved the prisma schema to: ${this._resolvedSchemaPath}`);

    // Check that the prisma schema exists
    if (!existsSync(this._resolvedSchemaPath)) {
      throw new Error(
        `PrismaExtension could not find the prisma schema at ${this._resolvedSchemaPath}. Make sure the path is correct: ${this.options.schema}, relative to the working dir ${context.workingDir}`
      );
    }
  }

  async onBuildComplete(context: BuildContext, manifest: BuildManifest) {
    if (context.target === "dev") {
      return;
    }

    assert(this._resolvedSchemaPath, "Resolved schema path is not set");

    context.logger.debug("Looking for @prisma/client in the externals", {
      externals: manifest.externals,
    });

    const prismaExternal = manifest.externals?.find(
      (external) => external.name === "@prisma/client"
    );

    let version = prismaExternal?.version ?? this.options.version;

    // If still no version, try to read from installed node_modules
    if (!version) {
      // First, try to read the actual installed @prisma/client version
      const installedPrismaPath = join(context.workingDir, "node_modules", "@prisma", "client", "package.json");
      if (existsSync(installedPrismaPath)) {
        try {
          const installedPkg = await readPackageJSON(installedPrismaPath);
          if (installedPkg?.version) {
            version = installedPkg.version;
            context.logger.debug(
              `PrismaExtension resolved version from node_modules: ${version}`
            );
          }
        } catch (e) {
          context.logger.debug("Failed to read @prisma/client from node_modules", { error: e });
        }
      }

      // If still no version, check for catalog/workspace references and provide helpful error
      if (!version) {
        const packageJsonPath = await resolvePackageJSON(context.workingDir);
        let errorDetail = "";

        if (packageJsonPath) {
          const pkg = await readPackageJSON(packageJsonPath);
          const versionSpec = pkg.dependencies?.["@prisma/client"] ||
                             pkg.devDependencies?.["@prisma/client"];

          if (versionSpec?.startsWith("catalog:")) {
            errorDetail = `Found pnpm catalog reference "${versionSpec}". `;
          } else if (versionSpec?.startsWith("workspace:")) {
            // Handle workspace: protocol - strip prefix and use the version if it's explicit
            const stripped = versionSpec.replace("workspace:", "").trim();
            if (stripped && stripped !== "*" && stripped !== "^" && stripped !== "~") {
              version = stripped;
              context.logger.debug(
                `PrismaExtension resolved version from workspace protocol: ${version}`
              );
            } else {
              errorDetail = `Found workspace reference "${versionSpec}". `;
            }
          }
        }

        if (!version) {
          throw new Error(
            `PrismaExtension could not determine the version of @prisma/client. ${errorDetail}` +
            `When using pnpm catalogs or workspace protocols, please provide an explicit version in the PrismaExtension options: ` +
            `prismaExtension({ version: "6.14.0", ... })`
          );
        }
      }
    }

    context.logger.debug(`PrismaExtension is generating the Prisma client for version ${version}`);

    const usingSchemaFolder = dirname(this._resolvedSchemaPath).endsWith("schema");

    const commands: string[] = [];

    let prismaDir: string | undefined;

    const generatorFlags: string[] = [];

    if (this.options.clientGenerator) {
      generatorFlags.push(`--generator=${this.options.clientGenerator}`);
    }

    if (this.options.typedSql) {
      generatorFlags.push(`--sql`);

      const prismaDir = usingSchemaFolder
        ? dirname(dirname(this._resolvedSchemaPath))
        : dirname(this._resolvedSchemaPath);

      context.logger.debug(`Using typedSql`);

      // Find all the files prisma/sql/*.sql
      const sqlFiles = await readdir(join(prismaDir, "sql")).then((files) =>
        files.filter((file) => file.endsWith(".sql"))
      );

      context.logger.debug(`Found sql files`, {
        sqlFiles,
      });

      const sqlDestinationPath = join(manifest.outputPath, "prisma", "sql");

      for (const file of sqlFiles) {
        const destination = join(sqlDestinationPath, file);
        const source = join(prismaDir, "sql", file);

        context.logger.debug(`Copying the sql from ${source} to ${destination}`);

        await cp(source, destination);
      }
    }

    if (usingSchemaFolder) {
      const schemaDir = dirname(this._resolvedSchemaPath);

      prismaDir = dirname(schemaDir);

      context.logger.debug(`Using the schema folder: ${schemaDir}`);

      // Find all the files in schemaDir that end with .prisma (excluding the schema.prisma file)
      const prismaFiles = await readdir(schemaDir).then((files) =>
        files.filter((file) => file.endsWith(".prisma"))
      );

      context.logger.debug(`Found prisma files in the schema folder`, {
        prismaFiles,
      });

      const schemaDestinationPath = join(manifest.outputPath, "prisma", "schema");

      const allPrismaFiles = [...prismaFiles];

      for (const file of allPrismaFiles) {
        const destination = join(schemaDestinationPath, file);
        const source = join(schemaDir, file);

        context.logger.debug(`Copying the prisma schema from ${source} to ${destination}`);

        await cp(source, destination);
      }

      commands.push(
        `${binaryForRuntime(
          manifest.runtime
        )} node_modules/prisma/build/index.js generate ${generatorFlags.join(" ")}` // Don't add the --schema flag or this will fail
      );
    } else {
      prismaDir = dirname(this._resolvedSchemaPath);
      // Now we need to add a layer that:
      // Copies the prisma schema to the build outputPath
      // Adds the `prisma` CLI dependency to the dependencies
      // Adds the `prisma generate` command, which generates the Prisma client
      const schemaDestinationPath = join(manifest.outputPath, "prisma", "schema.prisma");
      // Copy the prisma schema to the build output path
      context.logger.debug(
        `Copying the prisma schema from ${this._resolvedSchemaPath} to ${schemaDestinationPath}`
      );

      await cp(this._resolvedSchemaPath, schemaDestinationPath);

      commands.push(
        `${binaryForRuntime(
          manifest.runtime
        )} node_modules/prisma/build/index.js generate --schema=./prisma/schema.prisma ${generatorFlags.join(
          " "
        )}`
      );
    }

    const env: Record<string, string | undefined> = {};

    if (this.options.migrate) {
      // Copy the migrations directory to the build output path
      const migrationsDir = join(prismaDir, "migrations");
      const migrationsDestinationPath = join(manifest.outputPath, "prisma", "migrations");

      context.logger.debug(
        `Copying the prisma migrations from ${migrationsDir} to ${migrationsDestinationPath}`
      );

      await cp(migrationsDir, migrationsDestinationPath, { recursive: true });

      commands.push(
        `${binaryForRuntime(manifest.runtime)} node_modules/prisma/build/index.js migrate deploy`
      );
    }

    env.DATABASE_URL = manifest.deploy.env?.DATABASE_URL;

    if (this.options.directUrlEnvVarName) {
      env[this.options.directUrlEnvVarName] =
        manifest.deploy.env?.[this.options.directUrlEnvVarName] ??
        process.env[this.options.directUrlEnvVarName];

      if (!env[this.options.directUrlEnvVarName]) {
        context.logger.warn(
          `prismaExtension could not resolve the ${this.options.directUrlEnvVarName} environment variable. Make sure you add it to your environment variables or provide it as an environment variable to the deploy CLI command. See our docs for more info: https://trigger.dev/docs/deploy-environment-variables`
        );
      }
    } else {
      env.DIRECT_URL = manifest.deploy.env?.DIRECT_URL;
      env.DIRECT_DATABASE_URL = manifest.deploy.env?.DIRECT_DATABASE_URL;
    }

    if (!env.DATABASE_URL) {
      context.logger.warn(
        `prismaExtension could not resolve the DATABASE_URL environment variable. Make sure you add it to your environment variables. See our docs for more info: https://trigger.dev/docs/deploy-environment-variables`
      );
    }

    context.logger.debug(`Adding the prisma layer with the following commands`, {
      commands,
      env,
      dependencies: {
        prisma: version,
      },
    });

    context.addLayer({
      id: "prisma",
      commands,
      dependencies: {
        prisma: version,
      },
      build: {
        env,
      },
    });
  }
}
