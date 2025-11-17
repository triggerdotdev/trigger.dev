import { BuildManifest, BuildTarget } from "@trigger.dev/core/v3";
import { binaryForRuntime, BuildContext, BuildExtension } from "@trigger.dev/core/v3/build";
import assert from "node:assert";
import { existsSync, statSync } from "node:fs";
import { cp, readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { resolvePathSync as esmResolveSync } from "../imports/mlly.js";
import { resolvePackageJSON } from "pkg-types";

export type PrismaLegacyModeExtensionOptions = {
  /**
   * "Legacy" mode ensures that your prisma client is generated during the deploy process and that the correct version of the Prisma generator is used.
   *
   * This mode is recommended for projects that are using the legacy "prisma-client-js" provider (pre-Prisma 7).
   *
   * When this mode is used, you don't need to make sure and run the `prisma generate` command yourself. This extension will handle it for you.
   */
  mode: "legacy";
  /**
   * The path to your Prisma schema file or directory.
   *
   * For single-file schemas: "./prisma/schema.prisma"
   * For multi-file schemas (Prisma 6.7+): "./prisma"
   *
   * @see https://www.prisma.io/docs/orm/prisma-schema/overview/location#multi-file-prisma-schema
   */
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
   *  mode: "legacy",
   *  schema: "./prisma/schema.prisma",
   *  clientGenerator: "client"
   * });
   * ```
   */
  clientGenerator?: string;
  directUrlEnvVarName?: string;
};

export type PrismaEngineOnlyModeExtensionOptions = {
  /**
   * "Engine-only" mode ensures that only the Prisma engines are included in the build.
   *
   * This mode is useful when you have already generated your Prisma client (e.g., with a custom output path)
   * and you just need to ensure the correct engine binaries are available at runtime.
   *
   * You need to make sure and run the `prisma generate` command yourself. This extension will not handle it for you.
   *
   * The extension will automatically detect the version of @prisma/client in your project.
   * You can optionally specify a version to override the auto-detection.
   *
   * @example
   *
   * ```ts
   * // Auto-detect version from @prisma/client
   * prismaExtension({
   *   mode: "engine-only",
   * });
   *
   * // Explicitly specify version
   * prismaExtension({
   *   mode: "engine-only",
   *   version: "6.19.0",
   * });
   * ```
   */
  mode: "engine-only";
  /**
   * Optional: Specify the version of @prisma/engines to install.
   * If not provided, the extension will attempt to detect the version from your @prisma/client installation.
   */
  version?: string;

  /**
   * Optional: Specify the binary target to use. When deploying to the trigger.dev cloud, the binary target is "debian-openssl-3.0.x"
   *
   * If you are deploying locally on macOS for example, the binary target would be something like "linux-arm64-openssl-3.0.x"
   */
  binaryTarget?: string;

  /**
   * Optional: Set to true to suppress the progress message that is logged when the extension is used.
   */
  silent?: boolean;
};

export type PrismaEngineModernModeExtensionOptions = {
  /**
   * Specify modern when using the new "prisma-client" provider (Prisma 7+).
   *
   * You will need to make sure and run the `prisma generate` command yourself. This extension will not handle it for you.
   *
   * @example
   *
   * ```ts
   * prismaExtension({
   *  mode: "modern",
   * });
   * ```
   */
  mode: "modern";
};

export type PrismaExtensionOptions =
  | PrismaLegacyModeExtensionOptions
  | PrismaEngineOnlyModeExtensionOptions
  | PrismaEngineModernModeExtensionOptions;

const BINARY_TARGET = "linux-arm64-openssl-3.0.x";

/**
 * Attempts to resolve the Prisma client version from the project.
 * Tries @prisma/client first, then falls back to the prisma package.
 */
async function resolvePrismaClientVersion(
  workingDir: string,
  logger: {
    debug: (message: string, data?: any) => void;
  }
): Promise<string | undefined> {
  // Try @prisma/client first
  const clientVersion = await tryResolvePrismaPackageVersion("@prisma/client", workingDir, logger);
  if (clientVersion) {
    return clientVersion;
  }

  // Fall back to prisma package
  const prismaVersion = await tryResolvePrismaPackageVersion("prisma", workingDir, logger);
  if (prismaVersion) {
    return prismaVersion;
  }

  return undefined;
}

/**
 * Attempts to resolve a specific Prisma package and extract its version
 */
async function tryResolvePrismaPackageVersion(
  packageName: string,
  workingDir: string,
  logger: {
    debug: (message: string, data?: any) => void;
  }
): Promise<string | undefined> {
  try {
    // Try to resolve the package using esmResolveSync
    const resolvedPath = esmResolveSync(packageName, {
      url: workingDir,
    });

    logger.debug(`Resolved ${packageName} module path`, {
      resolvedPath,
      workingDir,
      packageName,
    });

    // Find the package.json for this resolved module
    const packageJsonPath = await resolvePackageJSON(dirname(resolvedPath), {
      test: async (filePath) => {
        try {
          const content = await readFile(filePath, "utf-8");
          const candidate = JSON.parse(content);

          // Exclude esm type markers
          return Object.keys(candidate).length > 1 || !candidate.type;
        } catch (error) {
          logger.debug("Error during package.json test", {
            error: error instanceof Error ? error.message : error,
            filePath,
          });

          return false;
        }
      },
    });

    if (!packageJsonPath) {
      logger.debug(`No package.json found for ${packageName}`, {
        resolvedPath,
      });
      return undefined;
    }

    logger.debug(`Found package.json for ${packageName}`, {
      packageJsonPath,
    });

    // Read and parse the package.json
    const packageJsonContent = await readFile(packageJsonPath, "utf-8");
    const packageJson = JSON.parse(packageJsonContent);

    if (packageJson.name === packageName && packageJson.version) {
      logger.debug(`Detected ${packageName} version`, {
        version: packageJson.version,
      });
      return packageJson.version;
    }

    logger.debug(`Package name mismatch or no version in package.json for ${packageName}`, {
      expectedName: packageName,
      actualName: packageJson.name,
      version: packageJson.version,
    });

    return undefined;
  } catch (error) {
    logger.debug(`Failed to resolve ${packageName}`, {
      error: error instanceof Error ? error.message : error,
      workingDir,
    });

    return undefined;
  }
}

export function prismaExtension(options: PrismaExtensionOptions): BuildExtension {
  switch (options.mode) {
    case "legacy":
      return new PrismaLegacyModeExtension(options);
    case "engine-only":
      return new PrismaEngineOnlyModeExtension(options);
    case "modern":
      return new PrismaEngineModernModeExtension(options);
  }
}

export class PrismaLegacyModeExtension implements BuildExtension {
  moduleExternals: string[];

  public readonly name = "PrismaExtension";

  private _resolvedSchemaPath?: string;

  constructor(private options: PrismaLegacyModeExtensionOptions) {
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
    this._resolvedSchemaPath = resolve(context.workingDir, this.options.schema!);

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

    // Detect if this is a multi-file schema (directory) or single file schema
    const isMultiFileSchema = statSync(this._resolvedSchemaPath).isDirectory();
    const usingSchemaFolder =
      !isMultiFileSchema && dirname(this._resolvedSchemaPath).endsWith("schema");

    context.logger.debug(`Schema detection`, {
      isMultiFileSchema,
      usingSchemaFolder,
      resolvedSchemaPath: this._resolvedSchemaPath,
    });

    let commands: string[] = [];

    let prismaDir: string | undefined;

    const generatorFlags: string[] = [];

    if (this.options.clientGenerator) {
      generatorFlags.push(`--generator=${this.options.clientGenerator}`);
    }

    if (this.options.typedSql) {
      generatorFlags.push(`--sql`);

      // Determine the prisma directory based on the schema structure
      let prismaDirForSql: string;
      if (isMultiFileSchema) {
        // For multi-file schemas, the resolved path IS the prisma directory
        prismaDirForSql = this._resolvedSchemaPath;
      } else if (usingSchemaFolder) {
        // For schema folders (e.g., prisma/schema/*.prisma), go up two levels
        prismaDirForSql = dirname(dirname(this._resolvedSchemaPath));
      } else {
        // For single file schemas (e.g., prisma/schema.prisma), go up one level
        prismaDirForSql = dirname(this._resolvedSchemaPath);
      }

      context.logger.debug(`Using typedSql`, {
        prismaDirForSql,
      });

      // Find all the files prisma/sql/*.sql
      const sqlFiles = await readdir(join(prismaDirForSql, "sql")).then((files) =>
        files.filter((file) => file.endsWith(".sql"))
      );

      context.logger.debug(`Found sql files`, {
        sqlFiles,
      });

      const sqlDestinationPath = join(manifest.outputPath, "prisma", "sql");

      for (const file of sqlFiles) {
        const destination = join(sqlDestinationPath, file);
        const source = join(prismaDirForSql, "sql", file);

        context.logger.debug(`Copying the sql from ${source} to ${destination}`);

        await cp(source, destination);
      }
    }

    if (isMultiFileSchema) {
      // For multi-file schemas, the resolved path IS the prisma directory
      prismaDir = this._resolvedSchemaPath;

      context.logger.debug(`Using multi-file schema directory: ${prismaDir}`);

      // Copy the entire prisma directory to the build output path
      const prismaDestinationPath = join(manifest.outputPath, "prisma");

      context.logger.debug(
        `Copying the prisma directory from ${prismaDir} to ${prismaDestinationPath}`
      );

      const prismaDirForFilter = prismaDir;
      await cp(prismaDir, prismaDestinationPath, {
        recursive: true,
        // Filter out migrations and sql directories as they're handled separately if needed
        filter: (source) => {
          const relativePath = source.replace(prismaDirForFilter, "");
          // Skip migrations and sql directories during initial copy
          return !relativePath.startsWith("/migrations") && !relativePath.startsWith("/sql");
        },
      });

      commands.push(
        `${binaryForRuntime(
          manifest.runtime
        )} node_modules/prisma/build/index.js generate ${generatorFlags.join(" ")}` // Don't add the --schema flag when using directory
      );
    } else if (usingSchemaFolder) {
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

      commands = [
        `${binaryForRuntime(manifest.runtime)} node_modules/prisma/build/index.js migrate deploy`,
        ...commands,
      ];
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

export class PrismaEngineOnlyModeExtension implements BuildExtension {
  public readonly name = "PrismaEngineOnlyModeExtension";
  private _binaryTarget: string;

  constructor(private options: PrismaEngineOnlyModeExtensionOptions) {
    this._binaryTarget = options.binaryTarget ?? "debian-openssl-3.0.x";
  }

  async onBuildComplete(context: BuildContext, manifest: BuildManifest) {
    if (context.target === "dev") {
      return;
    }

    // Try to detect the version if not provided
    let version = this.options.version;

    if (!version) {
      context.logger.debug("Attempting to detect @prisma/client version from the project");

      version = await resolvePrismaClientVersion(context.workingDir, context.logger);

      if (version) {
        // Log a nice message to the user which version was detected, and give them instructions on how to override it
        context.logger.progress(
          `prismaExtension: detected prisma ${version}. Override via prismaExtension({ mode: "engine-only", version: "6.19.0" })`
        );
      }
    }

    if (!version) {
      throw new Error(
        `PrismaEngineOnlyModeExtension could not determine the version of @prisma/client. Please provide a version in the PrismaExtension options: prismaExtension({ mode: "engine-only", version: "6.19.0" })`
      );
    }

    context.logger.debug(
      `PrismaEngineOnlyModeExtension is installing engines for version ${version}`
    );

    const commands: string[] = [
      // Install the engines package
      `npm install @prisma/engines@${version}`,
      ...generateCpCommandsForLocation("/app/prisma-engines", this._binaryTarget),
    ];

    context.addLayer({
      id: "prisma-engines",
      commands,
      deploy: {
        env: {
          PRISMA_QUERY_ENGINE_LIBRARY: `/app/prisma-engines/libquery_engine-${this._binaryTarget}.so.node`,
          PRISMA_QUERY_ENGINE_SCHEMA_ENGINE: `/app/prisma-engines/schema-engine-${this._binaryTarget}`,
        },
      },
    });

    if (!this.options.silent) {
      context.logger.progress(
        "prismaExtension: setting PRISMA_QUERY_ENGINE_LIBRARY and PRISMA_QUERY_ENGINE_SCHEMA_ENGINE env variables"
      );
      // Now logs output a pretty message to the user that they need to make sure they have already run `prisma generate` and they also have added
      // the binary target to the prisma schema file like so: binaryTargets = ["native", "debian-openssl-3.0.x"]
      context.logger.progress(
        `prismaExtension: in engine-only mode you are required to run \`prisma generate\` and ensure your schema.prisma file has binaryTargets = ["native", "${this._binaryTarget}"]`
      );
    }
  }
}

function generateCpCommandsForLocation(location: string, binaryTarget: string) {
  return [
    `mkdir -p ${location} && cp node_modules/@prisma/engines/libquery_engine-${binaryTarget}.so.node ${location}/`,
    `mkdir -p ${location} && cp node_modules/@prisma/engines/schema-engine-${binaryTarget} ${location}/`,
  ];
}

export class PrismaEngineModernModeExtension implements BuildExtension {
  moduleExternals: string[];

  public readonly name = "PrismaEngineModernModeExtension";

  constructor(private options: PrismaEngineModernModeExtensionOptions) {
    this.moduleExternals = ["@prisma/client"];
  }

  externalsForTarget(target: BuildTarget) {
    return this.moduleExternals;
  }
}
