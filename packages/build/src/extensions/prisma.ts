import { BuildManifest, BuildTarget } from "@trigger.dev/core/v3";
import { binaryForRuntime, BuildContext, BuildExtension } from "@trigger.dev/core/v3/build";
import assert from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { cp, readdir } from "node:fs/promises";
import { dirname, join, resolve, extname } from "node:path";
import { pathToFileURL } from "url";

// Utility to load prisma.config.ts if it exists
async function loadPrismaConfig(workingDir: string): Promise<any | undefined> {
  const configPath = resolve(workingDir, "prisma.config.ts");
  if (!existsSync(configPath)) return undefined;
  // Use dynamic import to load the config (assumes ESM or transpiled TS)
  try {
    const config = await import(pathToFileURL(configPath).href);
    return config.default || config;
  } catch (e) {
    throw new Error(`Failed to load prisma.config.ts: ${e}`);
  }
}

export type PrismaExtensionOptions = {
  schema?: string; // Now optional if provided in config
  output?: string; // New: explicit output path for Prisma client
  migrate?: boolean;
  version?: string;
  typedSql?: boolean;
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
  private _resolvedOutputPath?: string;
  private _prismaConfig?: any;

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
    // Load prisma.config.ts if it exists
    this._prismaConfig = await loadPrismaConfig(context.workingDir);
    // Determine schema path
    const schemaPath =
      this.options.schema || this._prismaConfig?.schema || this._prismaConfig?.schemaPath;
    if (!schemaPath) {
      throw new Error(
        `PrismaExtension requires a schema path. Provide it in options or prisma.config.ts (schema or schemaPath).`
      );
    }
    this._resolvedSchemaPath = resolve(context.workingDir, schemaPath);
    context.logger.debug(`Resolved the prisma schema to: ${this._resolvedSchemaPath}`);
    if (!existsSync(this._resolvedSchemaPath)) {
      throw new Error(
        `PrismaExtension could not find the prisma schema at ${this._resolvedSchemaPath}. Make sure the path is correct: ${schemaPath}, relative to the working dir ${context.workingDir}`
      );
    }
    // Determine output path for Prisma client
    const outputPath =
      this.options.output || this._prismaConfig?.output || this._prismaConfig?.clientOutput;
    if (!outputPath) {
      throw new Error(
        `PrismaExtension requires an output path for the Prisma client. Provide it in options or prisma.config.ts (output or clientOutput).`
      );
    }
    this._resolvedOutputPath = resolve(context.workingDir, outputPath);
    context.logger.debug(`Resolved the Prisma client output to: ${this._resolvedOutputPath}`);
  }

  async onBuildComplete(context: BuildContext, manifest: BuildManifest) {
    if (context.target === "dev") {
      return;
    }
    assert(this._resolvedSchemaPath, "Resolved schema path is not set");
    assert(this._resolvedOutputPath, "Resolved output path is not set");
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
    const generatorFlags: string[] = [];
    if (this.options.clientGenerator) {
      generatorFlags.push(`--generator=${this.options.clientGenerator}`);
    }
    if (this.options.typedSql) {
      generatorFlags.push(`--sql`);
    }
    // Copy schema.prisma to output
    const schemaDestinationPath = join(manifest.outputPath, "prisma", "schema.prisma");
    context.logger.debug(
      `Copying the prisma schema from ${this._resolvedSchemaPath} to ${schemaDestinationPath}`
    );
    await cp(this._resolvedSchemaPath, schemaDestinationPath);
    // Copy migrations if enabled
    if (this.options.migrate) {
      const migrationsDir = join(dirname(this._resolvedSchemaPath), "migrations");
      const migrationsDestinationPath = join(manifest.outputPath, "prisma", "migrations");
      context.logger.debug(
        `Copying the prisma migrations from ${migrationsDir} to ${migrationsDestinationPath}`
      );
      await cp(migrationsDir, migrationsDestinationPath, { recursive: true });
      commands.push(
        `${binaryForRuntime(manifest.runtime)} node_modules/prisma/build/index.js migrate deploy`
      );
    }
    // Generate Prisma client using explicit output and schema
    commands.push(
      `${binaryForRuntime(manifest.runtime)} node_modules/prisma/build/index.js generate --schema=./prisma/schema.prisma --output=${this._resolvedOutputPath} ${generatorFlags.join(" ")}`
    );
    // Set up environment variables
    const env: Record<string, string | undefined> = {};
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
