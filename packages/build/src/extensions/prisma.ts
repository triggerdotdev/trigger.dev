import { BuildManifest, BuildTarget } from "@trigger.dev/core/v3";
import { binaryForRuntime, BuildContext, BuildExtension } from "@trigger.dev/core/v3/build";
import assert from "node:assert";
import { existsSync } from "node:fs";
import { cp, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export type PrismaExtensionOptions = {
  schema: string;
  migrate?: boolean;
  version?: string;
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

    const version = prismaExternal?.version ?? this.options.version;

    if (!version) {
      throw new Error(
        `PrismaExtension could not determine the version of @prisma/client. It's possible that the @prisma/client was not used in the project. If this isn't the case, please provide a version in the PrismaExtension options.`
      );
    }

    context.logger.debug(`PrismaExtension is generating the Prisma client for version ${version}`);

    const usingSchemaFolder = dirname(this._resolvedSchemaPath).endsWith("schema");

    const commands: string[] = [];

    let prismaDir: string | undefined;

    const generatorFlag = this.options.clientGenerator
      ? `--generator=${this.options.clientGenerator}`
      : "";

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
        )} node_modules/prisma/build/index.js generate ${generatorFlag}` // Don't add the --schema flag or this will fail
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
        )} node_modules/prisma/build/index.js generate --schema=./prisma/schema.prisma ${generatorFlag}`
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

      env.DATABASE_URL = manifest.deploy.env?.DATABASE_URL;

      if (this.options.directUrlEnvVarName) {
        env[this.options.directUrlEnvVarName] =
          manifest.deploy.env?.[this.options.directUrlEnvVarName];
      } else {
        env.DIRECT_URL = manifest.deploy.env?.DIRECT_URL;
      }
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
