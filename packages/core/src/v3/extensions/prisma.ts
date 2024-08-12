import assert from "node:assert";
import { existsSync } from "node:fs";
import { cp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BuildContext, BuildExtension } from "../build/extensions.js";
import { BuildManifest, BuildTarget } from "../schemas/build.js";
import { binaryForRuntime } from "../build/runtime.js";

export type PrismaExtensionOptions = {
  schema: string;
  migrate?: boolean;
  version?: string;
};

const BINARY_TARGET = "linux-arm64-openssl-3.0.x";

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

    console.log(`Resolved the prisma schema to: ${this._resolvedSchemaPath}`);

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

    console.log("Looking for @prisma/client in the externals", {
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

    console.log(`PrismaExtension is generating the Prisma client for version ${version}`);

    // Now we need to add a layer that:
    // Copies the prisma schema to the build outputPath
    // Adds the `prisma` CLI dependency to the dependencies
    // Adds the `prisma generate` command, which generates the Prisma client
    const schemaDestinationPath = join(manifest.outputPath, "prisma", "schema.prisma");
    // Copy the prisma schema to the build output path
    console.log(
      `Copying the prisma schema from ${this._resolvedSchemaPath} to ${schemaDestinationPath}`
    );

    await cp(this._resolvedSchemaPath, schemaDestinationPath);

    const commands = [
      `${binaryForRuntime(
        manifest.runtime
      )} node_modules/prisma/build/index.js generate --schema=./prisma/schema.prisma`,
    ];

    if (this.options.migrate) {
      commands.push(
        `${binaryForRuntime(manifest.runtime)} node_modules/prisma/build/index.js migrate deploy`
      );
    }

    context.addLayer({
      id: "prisma",
      commands,
      dependencies: {
        prisma: version,
      },
      build: this.options.migrate
        ? {
            env: {
              DATABASE_URL: manifest.deploy.env?.DATABASE_URL,
              DATABASE_DIRECT_URL:
                manifest.deploy.env?.DATABASE_DIRECT_URL ??
                manifest.deploy.env?.DIRECT_URL ??
                manifest.deploy.env?.DATABASE_URL,
              DIRECT_URL:
                manifest.deploy.env?.DATABASE_DIRECT_URL ??
                manifest.deploy.env?.DIRECT_URL ??
                manifest.deploy.env?.DATABASE_URL,
            },
          }
        : {},
    });
  }
}
