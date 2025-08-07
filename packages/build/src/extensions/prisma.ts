import { BuildManifest, BuildTarget } from "@trigger.dev/core/v3";
import { binaryForRuntime, BuildContext, BuildExtension } from "@trigger.dev/core/v3/build";
import assert from "node:assert";
import { existsSync, readFileSync, statSync } from "node:fs";
import { cp, readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

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
  /**
   * Custom client output path for Prisma 6.6.0+ compatibility.
   * If not provided, will attempt to detect from schema or use default.
   */
  clientOutput?: string;
  /**
   * Path to prisma.config.ts file for advanced configuration.
   * If provided, will use this to determine schema location and other settings.
   */
  configFile?: string;
};

const BINARY_TARGET = "linux-arm64-openssl-3.0.x";

type SchemaConfig = {
  schemaPath: string;
  isMultiFile: boolean;
  hasSchemaFolder: boolean;
  clientOutput?: string;
  prismaDir: string;
};

/**
 * Attempts to read and parse package.json to find Prisma schema configuration
 */
function getSchemaFromPackageJson(workingDir: string): string | undefined {
  const packageJsonPath = join(workingDir, "package.json");
  if (!existsSync(packageJsonPath)) {
    return undefined;
  }

  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
    return packageJson.prisma?.schema;
  } catch {
    return undefined;
  }
}

/**
 * Detects schema configuration and handles both single-file and multi-file schemas
 */
function detectSchemaConfig(
  workingDir: string,
  schemaOption: string,
  configFile?: string
): SchemaConfig {
  let resolvedSchemaPath: string;
  let clientOutput: string | undefined;

  // First try to resolve the schema path
  if (configFile) {
    // TODO: In the future, we could parse prisma.config.ts to get schema location
    // For now, we'll use the schema option as fallback
    resolvedSchemaPath = resolve(workingDir, schemaOption);
  } else {
    // Check package.json for schema configuration
    const packageJsonSchema = getSchemaFromPackageJson(workingDir);
    if (packageJsonSchema) {
      resolvedSchemaPath = resolve(workingDir, packageJsonSchema);
    } else {
      resolvedSchemaPath = resolve(workingDir, schemaOption);
    }
  }

  const isDirectory = existsSync(resolvedSchemaPath) && 
    statSync(resolvedSchemaPath).isDirectory();

  if (isDirectory) {
    // Multi-file schema - look for schema.prisma in the directory
    const schemaFile = join(resolvedSchemaPath, "schema.prisma");
    if (existsSync(schemaFile)) {
      return {
        schemaPath: schemaFile,
        isMultiFile: true,
        hasSchemaFolder: true,
        clientOutput,
        prismaDir: resolvedSchemaPath,
      };
    } else {
      throw new Error(
        `Multi-file schema directory found at ${resolvedSchemaPath} but no schema.prisma file found. ` +
        `For multi-file schemas, you need a main schema.prisma file that contains your datasource and generator blocks.`
      );
    }
  } else {
    // Single file schema
    const schemaDir = dirname(resolvedSchemaPath);
    const schemaFileName = basename(resolvedSchemaPath);
    
    // Check if this is in a "schema" folder structure (but don't assume it's multi-file)
    const hasSchemaFolder = schemaDir.endsWith("schema") && schemaFileName === "schema.prisma";
    
    return {
      schemaPath: resolvedSchemaPath,
      isMultiFile: false,
      hasSchemaFolder,
      clientOutput,
      prismaDir: hasSchemaFolder ? dirname(schemaDir) : schemaDir,
    };
  }
}

/**
 * Reads the schema file and attempts to detect the client output path from generator blocks
 */
function detectClientOutputFromSchema(schemaPath: string): string | undefined {
  if (!existsSync(schemaPath)) {
    return undefined;
  }

  try {
    const schemaContent = readFileSync(schemaPath, "utf-8");
    
    // Look for generator client blocks with output paths
    const generatorMatches = schemaContent.match(/generator\s+\w+\s*{[^}]+}/g);
    
    if (generatorMatches) {
      for (const generator of generatorMatches) {
        // Check if it's a client generator (prisma-client-js or prisma-client)
        if (generator.includes('provider = "prisma-client') || generator.includes("provider = 'prisma-client")) {
          // Look for output path
          const outputMatch = generator.match(/output\s*=\s*["']([^"']+)["']/);
          if (outputMatch) {
            return outputMatch[1];
          }
        }
      }
    }
  } catch {
    // If we can't read or parse the schema, continue without client output detection
  }

  return undefined;
}

export function prismaExtension(options: PrismaExtensionOptions): PrismaExtension {
  return new PrismaExtension(options);
}

export class PrismaExtension implements BuildExtension {
  moduleExternals: string[];

  public readonly name = "PrismaExtension";

  private _schemaConfig?: SchemaConfig;

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

    // Detect schema configuration using enhanced logic
    try {
      this._schemaConfig = detectSchemaConfig(
        context.workingDir,
        this.options.schema,
        this.options.configFile
      );

      context.logger.debug(`Detected Prisma schema configuration:`, {
        schemaPath: this._schemaConfig.schemaPath,
        isMultiFile: this._schemaConfig.isMultiFile,
        hasSchemaFolder: this._schemaConfig.hasSchemaFolder,
        prismaDir: this._schemaConfig.prismaDir,
      });

      // Check that the resolved schema file exists
      if (!existsSync(this._schemaConfig.schemaPath)) {
        throw new Error(
          `PrismaExtension could not find the prisma schema at ${this._schemaConfig.schemaPath}. ` +
          `Make sure the path is correct: ${this.options.schema}, relative to the working dir ${context.workingDir}. ` +
          `For multi-file schemas, ensure you have a main schema.prisma file with your datasource and generator blocks.`
        );
      }

      // Try to detect client output from schema if not provided in options
      if (!this.options.clientOutput) {
        const detectedOutput = detectClientOutputFromSchema(this._schemaConfig.schemaPath);
        if (detectedOutput) {
          this._schemaConfig.clientOutput = detectedOutput;
          context.logger.debug(`Detected client output path from schema: ${detectedOutput}`);
        }
      } else {
        this._schemaConfig.clientOutput = this.options.clientOutput;
      }

    } catch (error) {
      throw new Error(
        `PrismaExtension failed to configure schema: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async onBuildComplete(context: BuildContext, manifest: BuildManifest) {
    if (context.target === "dev") {
      return;
    }

    assert(this._schemaConfig, "Schema configuration is not set");

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

    const commands: string[] = [];
    const { schemaPath, isMultiFile, hasSchemaFolder, prismaDir, clientOutput } = this._schemaConfig;

    const generatorFlags: string[] = [];

    if (this.options.clientGenerator) {
      generatorFlags.push(`--generator=${this.options.clientGenerator}`);
    }

    if (this.options.typedSql) {
      generatorFlags.push(`--sql`);

      context.logger.debug(`Using typedSql with prismaDir: ${prismaDir}`);

      // Find all the files prisma/sql/*.sql
      const sqlDir = join(prismaDir, "sql");
      if (existsSync(sqlDir)) {
        const sqlFiles = await readdir(sqlDir).then((files) =>
          files.filter((file) => file.endsWith(".sql"))
        );

        context.logger.debug(`Found sql files`, {
          sqlFiles,
        });

        const sqlDestinationPath = join(manifest.outputPath, "prisma", "sql");

        for (const file of sqlFiles) {
          const destination = join(sqlDestinationPath, file);
          const source = join(sqlDir, file);

          context.logger.debug(`Copying the sql from ${source} to ${destination}`);

          await cp(source, destination);
        }
      } else {
        context.logger.warn(`TypedSQL enabled but no sql directory found at ${sqlDir}`);
      }
    }

    // Handle schema copying based on configuration
    if (isMultiFile || hasSchemaFolder) {
      const schemaDir = dirname(schemaPath);
      
      context.logger.debug(`Using multi-file or schema folder setup: ${schemaDir}`);

      // Find all the files in schemaDir that end with .prisma
      const prismaFiles = await readdir(schemaDir).then((files) =>
        files.filter((file) => file.endsWith(".prisma"))
      );

      context.logger.debug(`Found prisma files in the schema directory`, {
        prismaFiles,
        schemaDir,
      });

      const schemaDestinationPath = join(manifest.outputPath, "prisma", "schema");

      for (const file of prismaFiles) {
        const destination = join(schemaDestinationPath, file);
        const source = join(schemaDir, file);

        context.logger.debug(`Copying the prisma schema from ${source} to ${destination}`);

        await cp(source, destination);
      }

      // For multi-file schemas, don't specify --schema flag
      const generateCommand = `${binaryForRuntime(
        manifest.runtime
      )} node_modules/prisma/build/index.js generate ${generatorFlags.join(" ")}`;
      
      commands.push(generateCommand);
      
    } else {
      // Single file schema
      const schemaDestinationPath = join(manifest.outputPath, "prisma", "schema.prisma");
      
      context.logger.debug(
        `Copying single prisma schema from ${schemaPath} to ${schemaDestinationPath}`
      );

      await cp(schemaPath, schemaDestinationPath);

      // For single file schemas, specify the schema path
      const generateCommand = `${binaryForRuntime(
        manifest.runtime
      )} node_modules/prisma/build/index.js generate --schema=./prisma/schema.prisma ${generatorFlags.join(
        " "
      )}`;
      
      commands.push(generateCommand);
    }

    // Add warning for Prisma 6.6.0+ if no client output is detected
    if (!clientOutput) {
      context.logger.warn(
        `No client output path detected in your Prisma schema. ` +
        `Starting with Prisma 6.6.0, you should specify an 'output' path in your generator block ` +
        `to avoid potential issues. See: https://www.prisma.io/docs/orm/prisma-client/setup-and-configuration/generating-prisma-client`
      );
    }

    const env: Record<string, string | undefined> = {};

    if (this.options.migrate) {
      // Copy the migrations directory to the build output path
      const migrationsDir = join(prismaDir, "migrations");
      
      if (existsSync(migrationsDir)) {
        const migrationsDestinationPath = join(manifest.outputPath, "prisma", "migrations");

        context.logger.debug(
          `Copying the prisma migrations from ${migrationsDir} to ${migrationsDestinationPath}`
        );

        await cp(migrationsDir, migrationsDestinationPath, { recursive: true });

        commands.push(
          `${binaryForRuntime(manifest.runtime)} node_modules/prisma/build/index.js migrate deploy`
        );
      } else {
        context.logger.warn(
          `Migration enabled but no migrations directory found at ${migrationsDir}. ` +
          `Make sure you have run 'prisma migrate dev' to create migrations.`
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
