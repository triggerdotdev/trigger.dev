import { BuildManifest, BuildTarget } from "@trigger.dev/core/v3";
import { binaryForRuntime, BuildContext, BuildExtension } from "@trigger.dev/core/v3/build";
import assert from "node:assert";
import { existsSync, statSync } from "node:fs";
import { cp, readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { resolvePathSync as esmResolveSync } from "../imports/mlly.js";
import { resolvePackageJSON } from "pkg-types";
import { LoadConfigFromFileError } from "@prisma/config";

export type PrismaLegacyModeExtensionOptions = {
  /**
   * Legacy mode configuration for Prisma 5.x/6.x with the `prisma-client-js` provider.
   *
   * **Use this mode when:**
   * - Using Prisma 5.x or 6.x with `prisma-client-js` provider
   * - You want automatic `prisma generate` during deployment
   * - You need migration support
   *
   * **Key features:**
   * - Automatic client generation
   * - Multi-file schema support (Prisma 6.7+)
   * - Config file support (`prisma.config.ts`)
   * - TypedSQL support
   * - Automatic version detection
   */
  mode: "legacy";
  /**
   * Path to your Prisma schema file or directory.
   *
   * **Examples:**
   * - Single file: `"./prisma/schema.prisma"`
   * - Multi-file (Prisma 6.7+): `"./prisma"`
   *
   * **Note:** Either `schema` or `configFile` must be specified, but not both.
   */
  schema?: string;
  /**
   * Path to your Prisma config file (`prisma.config.ts`).
   *
   * Uses `@prisma/config` to automatically extract schema and migrations paths.
   * Requires Prisma 6+ with config file support.
   *
   * **Example:**
   * ```ts
   * prismaExtension({
   *   mode: "legacy",
   *   configFile: "./prisma.config.ts",
   *   migrate: true,
   * });
   * ```
   *
   * **Note:** Either `schema` or `configFile` must be specified, but not both.
   */
  configFile?: string;
  /**
   * Enable automatic database migrations during deployment.
   *
   * Runs `prisma migrate deploy` before generating the client.
   * Requires `directUrlEnvVarName` to be set.
   */
  migrate?: boolean;
  /**
   * Override the auto-detected Prisma version.
   *
   * **Auto-detection:** Checks externals, then `@prisma/client` in node_modules, then `prisma` package.
   */
  version?: string;
  /**
   * Enable TypedSQL support. Adds `--sql` flag to `prisma generate`.
   *
   * Requires Prisma 5.19+ and `previewFeatures = ["typedSql"]` in your schema.
   */
  typedSql?: boolean;
  /**
   * Specify which generator to use when you have multiple generators.
   *
   * Adds `--generator=<name>` to only generate the specified generator.
   * Useful for skipping extra generators like `typegraphql-prisma`.
   */
  clientGenerator?: string;
  /**
   * Environment variable name for the direct (unpooled) database connection.
   *
   * Required for migrations. Common values: `"DATABASE_URL_UNPOOLED"`, `"DIRECT_URL"`.
   */
  directUrlEnvVarName?: string;
};

export type PrismaEngineOnlyModeExtensionOptions = {
  /**
   * Engine-only mode for custom Prisma client output paths.
   *
   * **Use this mode when:**
   * - You're using a custom output path for Prisma Client
   * - You want to control when `prisma generate` runs
   * - You run `prisma generate` in your build pipeline
   *
   * **What it does:**
   * - Installs engine binaries only (no client generation)
   * - Sets `PRISMA_QUERY_ENGINE_LIBRARY` and `PRISMA_QUERY_ENGINE_SCHEMA_ENGINE` env vars
   * - Auto-detects version from filesystem
   *
   * **You must:** Run `prisma generate` yourself and include correct `binaryTargets` in your schema.
   */
  mode: "engine-only";
  /**
   * Prisma version to use. Auto-detected from `@prisma/client` or `prisma` package if omitted.
   *
   * **Recommended:** Specify explicitly for reproducible builds.
   */
  version?: string;

  /**
   * Binary target platform for Prisma engines.
   *
   * **Default:** `"debian-openssl-3.0.x"` (for Trigger.dev Cloud)
   * **Local Docker on ARM:** `"linux-arm64-openssl-3.0.x"`
   */
  binaryTarget?: string;

  /**
   * Suppress progress messages during the build.
   */
  silent?: boolean;
};

export type PrismaEngineModernModeExtensionOptions = {
  /**
   * Modern mode for Prisma 6.16+ (with `prisma-client` provider) and Prisma 7.
   *
   * **Use this mode when:**
   * - Using Prisma 6.16+ with `provider = "prisma-client"` and `engineType = "client"`
   * - Using Prisma 7 beta or later
   * - Using database adapters (e.g., `@prisma/adapter-pg`)
   *
   * **What it does:**
   * - Marks `@prisma/client` as external (zero config)
   * - Works with TypeScript-only client (no Rust binaries)
   *
   * **You must:** Run `prisma generate` yourself and install database adapters.
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

/**
 * Loads a Prisma config file using @prisma/config and extracts the schema path and other configuration
 */
async function loadPrismaConfig(
  configFilePath: string,
  workingDir: string,
  logger: {
    debug: (message: string, data?: any) => void;
  }
): Promise<{
  schema: string;
  migrationsPath?: string;
}> {
  try {
    // Resolve the config file path relative to the working directory
    const resolvedConfigPath = resolve(workingDir, configFilePath);

    logger.debug(`[PrismaExtension] loadPrismaConfig called`, {
      configFilePath,
      resolvedConfigPath,
      workingDir,
    });

    // Check that the config file exists
    if (!existsSync(resolvedConfigPath)) {
      throw new Error(
        `Prisma config file not found at ${resolvedConfigPath}. Make sure the path is correct: ${configFilePath}, relative to the working dir ${workingDir}`
      );
    }

    logger.debug(`[PrismaExtension] Config file exists, loading with @prisma/config`);

    // Dynamically import @prisma/config
    const { loadConfigFromFile } = await import("@prisma/config");

    // Load the config using @prisma/config
    const configResult = await loadConfigFromFile({
      configFile: resolvedConfigPath,
      configRoot: workingDir,
    });

    logger.debug(`[PrismaExtension] loadConfigFromFile completed`, {
      hasError: !!configResult.error,
      errorTag: configResult.error?._tag,
    });

    function prettyConfigError(error: LoadConfigFromFileError): string {
      switch (error._tag) {
        case "ConfigFileNotFound":
          return `Config file not found at ${resolvedConfigPath}`;
        case "ConfigLoadError":
          return `Config file parse error: ${error.error.message}`;
        case "ConfigFileSyntaxError":
          return `Config file syntax error: ${error.error.message}`;
        default:
          return `Unknown config error: ${String(error.error.message)}`;
      }
    }

    if (configResult.error) {
      throw new Error(
        `Failed to load Prisma config from ${resolvedConfigPath}: ${prettyConfigError(
          configResult.error
        )}`
      );
    }

    logger.debug(`[PrismaExtension] Config parsed successfully`, {
      schema: configResult.config.schema,
      migrationsPath: configResult.config.migrations?.path,
      fullMigrations: configResult.config.migrations,
    });

    // Extract the schema path
    if (!configResult.config.schema) {
      throw new Error(`Prisma config file at ${resolvedConfigPath} does not specify a schema path`);
    }

    const result = {
      schema: configResult.config.schema,
      migrationsPath: configResult.config.migrations?.path,
    };

    logger.debug(`[PrismaExtension] Returning config result`, result);

    return result;
  } catch (error) {
    logger.debug(`[PrismaExtension] Error loading config`, {
      error: error instanceof Error ? error.message : error,
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw new Error(
      `Failed to load Prisma config from ${configFilePath}: ${
        error instanceof Error ? error.message : error
      }`
    );
  }
}

/**
 * Prisma build extension for Trigger.dev deployments.
 *
 * **Three modes available:**
 * - `"legacy"` - Prisma 5.x/6.x with `prisma-client-js`, automatic generation
 * - `"engine-only"` - Custom output paths, manual generation control
 * - `"modern"` - Prisma 6.16+/7.x with `prisma-client` provider
 *
 * @example Legacy mode (most common)
 * ```ts
 * prismaExtension({
 *   mode: "legacy",
 *   schema: "prisma/schema.prisma",
 *   migrate: true,
 *   typedSql: true,
 * });
 * ```
 *
 * @example Engine-only mode (custom output)
 * ```ts
 * prismaExtension({
 *   mode: "engine-only",
 *   version: "6.19.0",
 * });
 * ```
 *
 * @example Modern mode (Prisma 7)
 * ```ts
 * prismaExtension({
 *   mode: "modern",
 * });
 * ```
 */
export function prismaExtension(options: PrismaExtensionOptions): BuildExtension {
  switch (options.mode) {
    case "legacy":
      return new PrismaLegacyModeExtension(options);
    case "engine-only":
      return new PrismaEngineOnlyModeExtension(options);
    case "modern":
      return new PrismaEngineModernModeExtension(options);
    default:
      return new PrismaLegacyModeExtension(options);
  }
}

export class PrismaLegacyModeExtension implements BuildExtension {
  moduleExternals: string[];

  public readonly name = "PrismaExtension";

  private _resolvedSchemaPath?: string;
  private _loadedConfig?: {
    schema: string;
    migrationsPath?: string;
  };

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

    context.logger.debug(`[PrismaExtension] onBuildStart called`, {
      workingDir: context.workingDir,
      options: {
        schema: this.options.schema,
        configFile: this.options.configFile,
        migrate: this.options.migrate,
        version: this.options.version,
        typedSql: this.options.typedSql,
        clientGenerator: this.options.clientGenerator,
        directUrlEnvVarName: this.options.directUrlEnvVarName,
      },
    });

    // Validate that either schema or configFile is provided, but not both
    if (!this.options.schema && !this.options.configFile) {
      throw new Error(
        `PrismaExtension requires either 'schema' or 'configFile' to be specified in the options`
      );
    }

    if (this.options.schema && this.options.configFile) {
      throw new Error(
        `PrismaExtension cannot have both 'schema' and 'configFile' specified. Please use only one.`
      );
    }

    let schemaPath: string;

    // If configFile is specified, load it and extract the schema path
    if (this.options.configFile) {
      context.logger.debug(
        `[PrismaExtension] Loading Prisma config from ${this.options.configFile}`
      );

      this._loadedConfig = await loadPrismaConfig(
        this.options.configFile,
        context.workingDir,
        context.logger
      );

      schemaPath = this._loadedConfig.schema;

      context.logger.debug(`[PrismaExtension] Config loaded successfully`, {
        schema: this._loadedConfig.schema,
        migrationsPath: this._loadedConfig.migrationsPath,
      });
    } else {
      schemaPath = this.options.schema!;
      context.logger.debug(`[PrismaExtension] Using schema from options: ${schemaPath}`);
    }

    // Resolve the path to the prisma schema, relative to the config.directory
    this._resolvedSchemaPath = resolve(context.workingDir, schemaPath);

    context.logger.debug(`[PrismaExtension] Resolved schema path`, {
      schemaPath,
      resolvedSchemaPath: this._resolvedSchemaPath,
      workingDir: context.workingDir,
    });

    // Check that the prisma schema exists
    if (!existsSync(this._resolvedSchemaPath)) {
      throw new Error(
        `PrismaExtension could not find the prisma schema at ${this._resolvedSchemaPath}. Make sure the path is correct: ${schemaPath}, relative to the working dir ${context.workingDir}`
      );
    }

    context.logger.debug(`[PrismaExtension] Schema file exists at ${this._resolvedSchemaPath}`);
  }

  async onBuildComplete(context: BuildContext, manifest: BuildManifest) {
    if (context.target === "dev") {
      return;
    }

    context.logger.debug(`[PrismaExtension] onBuildComplete called`);

    assert(this._resolvedSchemaPath, "Resolved schema path is not set");

    context.logger.debug(`[PrismaExtension] Looking for @prisma/client in the externals`, {
      externals: manifest.externals,
    });

    const prismaExternal = manifest.externals?.find(
      (external) => external.name === "@prisma/client"
    );

    let version = prismaExternal?.version ?? this.options.version;

    // If we couldn't find the version in externals or options, try to resolve it from the filesystem
    if (!version) {
      context.logger.debug(
        `[PrismaExtension] Version not found in externals, attempting to detect from filesystem`
      );

      version = await resolvePrismaClientVersion(context.workingDir, context.logger);

      if (version) {
        context.logger.debug(`[PrismaExtension] Detected version from filesystem: ${version}`);
      }
    }

    if (!version) {
      throw new Error(
        `PrismaExtension could not determine the version of @prisma/client. It's possible that the @prisma/client was not used in the project. If this isn't the case, please provide a version in the PrismaExtension options.`
      );
    }

    context.logger.debug(`[PrismaExtension] Using Prisma version ${version}`, {
      source: prismaExternal ? "externals" : this.options.version ? "options" : "filesystem",
    });

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

    context.logger.debug(`[PrismaExtension] Checking if migrations are enabled`, {
      migrate: this.options.migrate,
      loadedConfigMigrationsPath: this._loadedConfig?.migrationsPath,
      prismaDir,
    });

    if (this.options.migrate) {
      context.logger.debug(
        `[PrismaExtension] Migrations enabled, determining migrations directory`
      );

      // Determine the migrations directory path
      let migrationsDir: string;

      if (this._loadedConfig?.migrationsPath) {
        // Use the migrations path from the config file
        migrationsDir = resolve(context.workingDir, this._loadedConfig.migrationsPath);
        context.logger.debug(`[PrismaExtension] Using migrations path from config`, {
          configMigrationsPath: this._loadedConfig.migrationsPath,
          resolvedMigrationsDir: migrationsDir,
          workingDir: context.workingDir,
        });
      } else {
        // Fall back to the default migrations directory
        migrationsDir = join(prismaDir, "migrations");
        context.logger.debug(`[PrismaExtension] Using default migrations path`, {
          prismaDir,
          migrationsDir,
        });
      }

      const migrationsDestinationPath = join(manifest.outputPath, "prisma", "migrations");

      context.logger.debug(`[PrismaExtension] Checking if migrations directory exists`, {
        migrationsDir,
        exists: existsSync(migrationsDir),
      });

      if (!existsSync(migrationsDir)) {
        context.logger.warn(
          `[PrismaExtension] Migrations directory not found at ${migrationsDir}. Skipping migrations copy.`
        );
      } else {
        context.logger.debug(
          `[PrismaExtension] Copying prisma migrations from ${migrationsDir} to ${migrationsDestinationPath}`
        );

        await cp(migrationsDir, migrationsDestinationPath, { recursive: true });

        context.logger.debug(`[PrismaExtension] Migrations copied successfully`);

        commands = [
          `${binaryForRuntime(manifest.runtime)} node_modules/prisma/build/index.js migrate deploy`,
          ...commands,
        ];

        context.logger.debug(`[PrismaExtension] Added migrate deploy command to commands array`);
      }
    } else {
      context.logger.debug(
        `[PrismaExtension] Migrations not enabled (migrate: ${this.options.migrate})`
      );
    }

    env.DATABASE_URL = manifest.deploy.env?.DATABASE_URL;

    // Handle directUrl environment variable configuration
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

    context.logger.debug(`[PrismaExtension] Final layer configuration`, {
      commands,
      commandsCount: commands.length,
      env: Object.keys(env),
      dependencies: {
        prisma: version,
      },
    });

    context.logger.debug(`[PrismaExtension] Commands to be executed:`, {
      commands: commands.map((cmd, idx) => `${idx + 1}. ${cmd}`),
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

    context.logger.debug(`[PrismaExtension] Layer added successfully`);
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
