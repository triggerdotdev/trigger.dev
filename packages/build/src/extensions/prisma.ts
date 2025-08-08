import { BuildManifest, BuildTarget } from "@trigger.dev/core/v3";
import { binaryForRuntime, BuildContext, BuildExtension } from "@trigger.dev/core/v3/build";
import assert from "node:assert";
import { existsSync, statSync } from "node:fs";
import { cp, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

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
  private _schemaIsDirectory?: boolean;

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

    // Resolve the path to the prisma schema (file or folder), relative to the config.directory
    this._resolvedSchemaPath = resolve(context.workingDir, this.options.schema);

    context.logger.debug(`Resolved Prisma schema path input`, {
      input: this.options.schema,
      resolved: this._resolvedSchemaPath,
      workingDir: context.workingDir,
    });

    // Check that the prisma schema path exists
    if (!existsSync(this._resolvedSchemaPath)) {
      throw new Error(
        `PrismaExtension could not find the Prisma schema path at ${this._resolvedSchemaPath}. Ensure the path is correct (received: ${this.options.schema}), relative to ${context.workingDir}`
      );
    }

    // Determine if the resolved path is a directory (multi-file schema) or a file
    this._schemaIsDirectory = statSync(this._resolvedSchemaPath).isDirectory();

    if (this._schemaIsDirectory) {
      // If a folder is provided, ensure there is a schema.prisma inside (datasource/generator live here)
      const mainSchemaPath = join(this._resolvedSchemaPath, "schema.prisma");
      if (!existsSync(mainSchemaPath)) {
        context.logger.warn(
          `PrismaExtension: The provided schema path is a directory (${this._resolvedSchemaPath}) but no schema.prisma was found inside. Ensure your multi-file schema folder contains a schema.prisma with datasource/generator blocks.`
        );
      }
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

    const version = prismaExternal?.version ?? this.options.version;

    if (!version) {
      throw new Error(
        `PrismaExtension could not determine the version of @prisma/client. It's possible that the @prisma/client was not used in the project. If this isn't the case, please provide a version in the PrismaExtension options.`
      );
    }

    context.logger.debug(`PrismaExtension is generating the Prisma client for version ${version}`);

    const schemaIsDirectory = Boolean(this._schemaIsDirectory);

    const commands: string[] = [];

    let prismaDir: string | undefined;

    const generatorFlags: string[] = [];

    if (this.options.clientGenerator) {
      generatorFlags.push(`--generator=${this.options.clientGenerator}`);
    }

    if (this.options.typedSql) {
      generatorFlags.push(`--sql`);

      const baseDirForSql = schemaIsDirectory
        ? this._resolvedSchemaPath
        : dirname(this._resolvedSchemaPath);

      context.logger.debug(`typedSql enabled; scanning for SQL files`, {
        baseDirForSql,
      });

      try {
        // Find all the files <baseDirForSql>/sql/*.sql
        const sqlDir = join(baseDirForSql, "sql");
        if (existsSync(sqlDir)) {
          const sqlFiles = await readdir(sqlDir).then((files) =>
            files.filter((file) => file.endsWith(".sql"))
          );

          context.logger.debug(`Found typedSql files`, { sqlFiles, sqlDir });

          const sqlDestinationPath = join(manifest.outputPath, "prisma", "sql");

          for (const file of sqlFiles) {
            const destination = join(sqlDestinationPath, file);
            const source = join(sqlDir, file);

            context.logger.debug(`Copying typedSql file`, { source, destination });
            await cp(source, destination);
          }
        } else {
          context.logger.debug(`No typedSql directory found`, { sqlDir });
        }
      } catch (err) {
        context.logger.warn(`Failed to copy typedSql files`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (schemaIsDirectory) {
      const schemaDir = this._resolvedSchemaPath;

      prismaDir = schemaDir;

      context.logger.debug(`Using a schema directory`, { schemaDir });

      // Find all the files in schemaDir that end with .prisma
      const prismaFiles = await readdir(schemaDir).then((files) =>
        files.filter((file) => file.endsWith(".prisma"))
      );

      context.logger.debug(`Found Prisma schema files`, { prismaFiles, schemaDir });

      const schemaDestinationPath = join(manifest.outputPath, "prisma", "schema");

      for (const file of prismaFiles) {
        const destination = join(schemaDestinationPath, file);
        const source = join(schemaDir, file);

        context.logger.debug(`Copying Prisma schema file`, { source, destination });
        await cp(source, destination);
      }

      // Explicitly pass the folder path to --schema for multi-file schemas
      commands.push(
        `${binaryForRuntime(
          manifest.runtime
        )} node_modules/prisma/build/index.js generate --schema=./prisma/schema ${generatorFlags.join(
          " "
        )}`
      );
    } else {
      prismaDir = dirname(this._resolvedSchemaPath);
      // Copies the prisma schema file to the build outputPath
      const schemaDestinationPath = join(manifest.outputPath, "prisma", "schema.prisma");
      context.logger.debug(`Copying Prisma schema file`, {
        source: this._resolvedSchemaPath,
        destination: schemaDestinationPath,
      });

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
      const migrationsDir = join(prismaDir!, "migrations");
      const migrationsDestinationPath = join(manifest.outputPath, "prisma", "migrations");

      if (existsSync(migrationsDir)) {
        context.logger.debug(`Copying Prisma migrations`, {
          source: migrationsDir,
          destination: migrationsDestinationPath,
        });

        await cp(migrationsDir, migrationsDestinationPath, { recursive: true });

        // Always pass --schema explicitly to ensure correct resolution when using multi-file schemas
        const schemaFlag = schemaIsDirectory
          ? "--schema=./prisma/schema"
          : "--schema=./prisma/schema.prisma";

        commands.push(
          `${binaryForRuntime(
            manifest.runtime
          )} node_modules/prisma/build/index.js migrate deploy ${schemaFlag}`
        );
      } else {
        context.logger.warn(
          `PrismaExtension: 'migrate' enabled but no migrations directory found at ${migrationsDir}. Skipping copy & migrate deploy.`
        );
      }
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
