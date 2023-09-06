import childProcess from "child_process";
import { build } from "esbuild";
import util from "util";
import { z } from "zod";
import { logger } from "../utils/logger";
import { resolvePath } from "../utils/parseNameAndPath";

const asyncExecFile = util.promisify(childProcess.execFile);

export const DeployCommandOptionsSchema = z.object({
  envFile: z.string(),
});

export type DevCommandOptions = z.infer<typeof DeployCommandOptionsSchema>;

export async function deployCommand(path: string, anyOptions: any) {
  const result = DeployCommandOptionsSchema.safeParse(anyOptions);

  if (!result.success) {
    logger.error(result.error.message);
    return;
  }
  const options = result.data;

  const resolvedPath = resolvePath(path);

  logger.info(`Deploying ${resolvedPath}...`);

  // Find all files with .background.ts extension in the given path
  const { stdout } = await asyncExecFile("find", [resolvedPath, "-name", "*.background.ts"], {
    encoding: "utf-8",
  });

  const files = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  logger.info(`Found ${files.length} background tasks`);

  // Each file is an entry point and should be built into a separate bundle (not to be output to a file but instead to be sent to the server)
  const bundle = await build({
    entryPoints: files,
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node18.12.1",
    write: false,
    minify: false,
    sourcemap: false,
    packages: "external",
    metafile: true,
    outdir: "dist",
  });

  logger.info(`Built bundle, extracting task IDs`);

  const tasks = await Promise.all(
    bundle.outputFiles.map(async (outputFile) => {
      const task = await findTask(outputFile.text);

      return {
        task,
        outputFile,
      };
    })
  );

  logger.info(`Found ${tasks.length} task IDs`);
}

import { CallExpression, Expression, parse } from "@swc/core";

import { Visitor } from "@swc/core/Visitor.js";

class BackgroundTaskVisitor extends Visitor {
  public id: string | null = null;
  public version: string | null = null;

  override visitCallExpression(n: CallExpression): Expression {
    if (
      n.type === "CallExpression" &&
      n.callee.type === "MemberExpression" &&
      n.callee.property.type === "Identifier" &&
      n.callee.property.value === "defineBackgroundTask"
    ) {
      const firstArg = n.arguments[0];

      if (firstArg && firstArg.expression.type === "ObjectExpression") {
        const properties = firstArg.expression.properties;

        properties.forEach((property) => {
          if (property.type === "KeyValueProperty") {
            const key = property.key;

            if (key.type === "Identifier" && key.value === "id") {
              const value = property.value;

              if (value.type === "StringLiteral") {
                this.id = value.value;
              }
            } else if (key.type === "Identifier" && key.value === "version") {
              const value = property.value;

              if (value.type === "StringLiteral") {
                this.version = value.value;
              }
            }
          }
        });
      }
    }

    return n;
  }
}

async function findTask(code: string): Promise<{ id: string; version: string } | null> {
  const ast = await parse(code);

  const visitor = new BackgroundTaskVisitor();

  visitor.visitProgram(ast);

  if (typeof visitor.id === "string" && typeof visitor.version === "string") {
    return {
      id: visitor.id,
      version: visitor.version,
    };
  }

  return null;
}
