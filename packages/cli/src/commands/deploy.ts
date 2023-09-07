import { CallExpression, Expression, parse } from "@swc/core";
import { Visitor } from "@swc/core/Visitor.js";
import type { DeployBackgroundTaskRequestBody } from "@trigger.dev/core";
import childProcess from "child_process";
import { build } from "esbuild";
import pathModule from "node:path";
import util from "util";
import { z } from "zod";
import { logger } from "../utils/logger";
import { listPackageDependencies } from "../utils/packageManagers";
import { resolvePath } from "../utils/parseNameAndPath";
import { getTriggerApiDetails } from "../utils/getTriggerApiDetails";
import { TriggerApi } from "../utils/triggerApi";

const asyncExecFile = util.promisify(childProcess.execFile);

export const DeployCommandOptionsSchema = z.object({
  envFile: z.string(),
  tag: z.string().optional(),
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

  const apiDetails = await getTriggerApiDetails(resolvedPath, options.envFile);

  if (!apiDetails) {
    logger.error("Could not find Trigger.dev API key");
    return;
  }

  logger.info(`Deploying ${resolvedPath}...`);

  // Find all files with .background.ts extension in the given path
  const { stdout } = await asyncExecFile("find", [resolvedPath, "-name", "*.background.ts"], {
    encoding: "utf-8",
    cwd: resolvedPath,
  });

  const files = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const entryPoints = files.map((path) => pathModule.relative(resolvedPath, path));

  logger.info(`Found ${files.length} background tasks`);

  // target is the process.version (e.g. v18.12.1) but we need to pass it as node18.12.1
  const target = `node${process.version.replace("v", "")}`;

  // Each file is an entry point and should be built into a separate bundle (not to be output to a file but instead to be sent to the server)
  const bundle = await build({
    entryPoints: entryPoints,
    bundle: true,
    format: "cjs",
    platform: "node",
    target,
    write: false,
    minify: false,
    sourcemap: "external",
    packages: "external",
    metafile: true,
    outdir: "dist",
  });

  logger.info(`Built bundle, extracting task IDs`);

  const tasks: DeployBackgroundTaskRequestBody[] = [];

  for (const entryPoint of entryPoints) {
    const task = await gatherBackgroundTaskDeployment(resolvedPath, entryPoint, bundle, options);

    if (task) {
      tasks.push(task);
    }
  }

  const apiClient = new TriggerApi(apiDetails.apiKey, apiDetails.apiUrl);

  for (const task of tasks) {
    const response = await apiClient.deployBackgroundTask(task);

    if (!response.ok) {
      logger.error(`Failed to deploy ${task.id}@${task.version}: ${response.error}`);
    } else {
      logger.info(`Deployed ${task.id}@${task.version}#${response.data.hash}`);
    }
  }
}

async function gatherBackgroundTaskDeployment(
  projectPath: string,
  file: string,
  bundle: TasksBundle,
  options: DevCommandOptions
): Promise<DeployBackgroundTaskRequestBody | undefined> {
  const outputKey = Object.keys(bundle.metafile.outputs).find(
    (o) => bundle.metafile.outputs[o]?.entryPoint === file
  );

  if (!outputKey) {
    return;
  }

  const outputMetadata = bundle.metafile.outputs[outputKey];

  if (!outputMetadata) {
    return;
  }

  const outputPath = pathModule.join(projectPath, outputKey);

  const outputFile = bundle.outputFiles.find((o) => o.path === outputPath);

  if (!outputFile) {
    return;
  }

  const outputSourcemapPath = pathModule.join(projectPath, `${outputKey}.map`);

  const outputSourcemapFile = bundle.outputFiles.find((o) => o.path === outputSourcemapPath);

  if (!outputSourcemapFile) {
    return;
  }

  const taskInfo = await findTask(outputFile.text);

  if (!taskInfo) {
    return;
  }

  const dependencies: Record<string, string> = {};
  const imports = new Set<string>();

  for (const importMeta of outputMetadata.imports) {
    if (
      importMeta.kind === "require-call" &&
      importMeta.external &&
      !nodeBuiltIn(importMeta.path)
    ) {
      imports.add(importMeta.path);
    }
  }

  const packageDependencies = await listPackageDependencies(projectPath, options.tag);

  for (const importName of imports) {
    const version = packageDependencies[importName];

    if (version) {
      dependencies[importName] = version;
    }
  }

  logger.info(`Found ${Object.keys(dependencies).length} dependencies`);

  return {
    id: taskInfo.id,
    version: taskInfo.version,
    bundle: outputFile.text,
    fileName: pathModule.basename(outputFile.path),
    sourcemap: outputSourcemapFile.text,
    dependencies,
    nodeVersion: process.version,
  };
}

function nodeBuiltIn(importName: string): boolean {
  if (importName.startsWith("node:")) {
    return true;
  }

  // Now we need to check for node built-in modules that don't use the node: prefix
  // See https://nodejs.org/api/modules.html#modules_core_modules
  const builtInModules = [
    "assert",
    "async_hooks",
    "buffer",
    "child_process",
    "cluster",
    "crypto",
    "dgram",
    "dns",
    "domain",
    "events",
    "fs",
    "http",
    "http2",
    "https",
    "inspector",
    "module",
    "net",
    "os",
    "path",
    "perf_hooks",
    "process",
    "punycode",
    "querystring",
    "readline",
    "repl",
    "stream",
    "string_decoder",
    "sys",
    "timers",
    "tls",
    "trace_events",
    "tty",
    "url",
    "util",
    "v8",
    "vm",
    "zlib",
  ];

  return builtInModules.includes(importName);
}

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

type TasksBundle = Awaited<ReturnType<typeof buildTasks>>;

async function buildTasks(files: Array<string>) {
  return await build({
    entryPoints: files,
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node18.12.1",
    write: false,
    minify: false,
    sourcemap: "external",
    packages: "external",
    external: ["@trigger.dev/*"],
    metafile: true,
    outdir: "dist",
  });
}
