import { execa } from "execa";
import * as nodePath from "node:path";
import * as fs from "node:fs";
import { logger } from "../src/utilities/logger.js";
import { findUpMultiple, findUp } from "find-up";
import { TaskRunExecutionResult, WorkerManifest } from "@trigger.dev/core/v3/schemas";
import { TaskRunProcess } from "../src/executions/taskRunProcess.js";
import { createTestHttpServer } from "@epic-web/test-server/http";
import { TestCase, TestCaseRun } from "./fixtures.js";
import { access } from "node:fs/promises";
import { MachinePreset } from "@trigger.dev/core/v3";

export type PackageManager = "npm" | "pnpm" | "yarn";

export const LOCKFILES = {
  npm: "package-lock.json",
  npmShrinkwrap: "npm-shrinkwrap.json",
  pnpm: "pnpm-lock.yaml",
  yarn: "yarn.lock",
  bun: "bun.lockb",
};

export async function installFixtureDeps(options: {
  fixtureDir: string;
  packageManager: PackageManager;
  workspaceDir: string;
}) {
  const { packageManager, workspaceDir } = options;

  if (["pnpm", "yarn"].includes(packageManager)) {
    const version = await detectPackageManagerVersion(options);

    debug(`Detected ${packageManager}@${version} from package.json 'engines' field`);

    const { stdout, stderr } = await execa("corepack", ["use", `${packageManager}@${version}`], {
      cwd: workspaceDir,
    });

    debug(stdout);

    if (stderr) console.error(stderr);
  } else {
    const { stdout, stderr } = await execa(packageManager, installArgs(packageManager), {
      cwd: workspaceDir,
      env: {
        ...process.env,
        NODE_PATH: nodePath.resolve(nodePath.join(workspaceDir, "node_modules")),
      },
    });

    debug(stdout);

    if (stderr) console.error(stderr);
  }
}

export async function parsePackageManager(
  packageManager: PackageManager | undefined,
  fixtureDir: string
): Promise<PackageManager> {
  let $packageManager: PackageManager;

  if (packageManager) {
    $packageManager = packageManager;
  } else {
    $packageManager = await detectPackageManagerFromArtifacts(fixtureDir);
  }

  return $packageManager;
}

export async function detectPackageManagerFromArtifacts(path: string): Promise<PackageManager> {
  const foundPath = await findUp(Object.values(LOCKFILES), { cwd: path });

  if (!foundPath) {
    throw new Error("Could not detect package manager from artifacts");
  }

  logger.debug("Found path from package manager artifacts", { foundPath });

  switch (nodePath.basename(foundPath)) {
    case LOCKFILES.yarn:
      logger.debug("Found yarn artifact", { foundPath });
      return "yarn";
    case LOCKFILES.pnpm:
      logger.debug("Found pnpm artifact", { foundPath });
      return "pnpm";
    case LOCKFILES.npm:
    case LOCKFILES.npmShrinkwrap:
      logger.debug("Found npm artifact", { foundPath });
      return "npm";
    case LOCKFILES.bun:
      logger.debug("Found bun artifact", { foundPath });
      return "npm";
    default:
      throw new Error(`Unhandled package manager detection path: ${foundPath}`);
  }
}

function debug(message: string) {
  if (logger.loggerLevel === "debug") {
    console.log(message);
  }
}

function installArgs(packageManager: string) {
  switch (packageManager) {
    case "bun":
      return ["install", "--frozen-lockfile"];
    case "pnpm":
    case "yarn":
      throw new Error("pnpm and yarn must install using `corepack use`");
    case "npm":
      return ["ci", "--no-audit"];
    default:
      throw new Error(`Unknown package manager '${packageManager}'`);
  }
}

async function detectPackageManagerVersion(options: {
  fixtureDir: string;
  packageManager: PackageManager;
  workspaceDir: string;
}): Promise<string> {
  const { fixtureDir, packageManager, workspaceDir } = options;
  const pkgPaths = await findUpMultiple("package.json", { cwd: workspaceDir, stopAt: fixtureDir });
  for (let pkgPath of pkgPaths) {
    const buffer = fs.readFileSync(pkgPath, "utf8");
    const pkgJSON = JSON.parse(buffer.toString());
    if (!pkgJSON.engines) continue;
    const version = pkgJSON.engines[packageManager];
    if (version) return version;
  }

  throw new Error(`No version found for package manager ${packageManager}`);
}

export interface TypeScriptError {
  file: string;
  line: number;
  column: number;
  message: string;
}

export interface TscResult {
  success: boolean;
  errors: TypeScriptError[];
  stdout: string;
  stderr: string;
}

export async function runTsc(
  cwd: string,
  tsconfigName: string = "tsconfig.json",
  binBasePath: string = cwd
): Promise<TscResult> {
  const tsconfigPath = nodePath.join(cwd, tsconfigName);
  const tscPath = nodePath.join(binBasePath, "node_modules", ".bin", "tsc");

  // Ensure the tsconfig file exists
  try {
    await access(tsconfigPath);
  } catch (error) {
    throw new Error(`TSConfig file not found: ${tsconfigPath}`);
  }

  try {
    logger.debug(`Running TypeScript compiler: ${tscPath} --project ${tsconfigPath} --noEmit`, {
      cwd,
    });

    const result = await execa(tscPath, ["--project", tsconfigPath, "--noEmit"], {
      cwd,
      reject: false,
    });

    const success = result.exitCode === 0;
    const errors = success ? [] : parseTypeScriptErrors(result.stderr);

    logger.debug(result.stdout);
    logger.debug(result.stderr);

    return {
      success,
      errors,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    throw new Error(`Failed to run TypeScript compiler: ${error}`);
  }
}

function parseTypeScriptErrors(stderr: string): TypeScriptError[] {
  const errorRegex = /(.+)\((\d+),(\d+)\):\s+error\s+TS\d+:\s+(.+)/g;
  const errors: TypeScriptError[] = [];
  let match;

  while ((match = errorRegex.exec(stderr)) !== null) {
    errors.push({
      file: match[1]!,
      line: parseInt(match[2]!, 10),
      column: parseInt(match[3]!, 10),
      message: match[4]!,
    });
  }

  return errors;
}

export type ExecuteTaskCaseRunOptions = {
  testCase: TestCase;
  run: TestCaseRun;
  destination: string;
  workerManifest: WorkerManifest;
  contentHash: string;
};

export type ExecuteTaskRunUsageReport = {
  durationMs: number;
};

export type ExecuteTaskRunResult = {
  result: TaskRunExecutionResult;
  usageReports: Array<ExecuteTaskRunUsageReport>;
  totalDurationMs: number;
  spans: Array<ExecuteTaskTraceEvent>;
};

export type ExecuteTaskTraceEvent = {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  durationMs: number;
  attributes?: { [key: string]: string | number | boolean | undefined };
};

export async function executeTestCaseRun({
  run,
  testCase,
  destination,
  workerManifest,
  contentHash,
}: ExecuteTaskCaseRunOptions): Promise<ExecuteTaskRunResult> {
  const usageReports: Array<ExecuteTaskRunUsageReport> = [];
  const spans: Array<ExecuteTaskTraceEvent> = [];

  // Create a disposable "server" instance.
  const server = await createTestHttpServer({
    defineRoutes(router) {
      router.post("/usage", async ({ req }) => {
        const jsonBody = await req.json();

        usageReports.push({
          durationMs: jsonBody.durationMs,
        });

        return Response.json({});
      });
      router.post("/v1/traces", async ({ req }) => {
        const jsonBody = await req.json();

        spans.push(...parseTraceBodyIntoEvents(jsonBody));
        // TODO: Implement trace endpoint
        return Response.json({});
      });
      router.post("/v1/logs", () => {
        // TODO: Implement logs endpoint
        return Response.json({});
      });
      router.post("/v1/chat/completions", async ({ req }) => {
        return Response.json({
          id: "chatcmpl-7XYZ123ABC456DEF789GHI",
          object: "chat.completion",
          created: 1631619199,
          model: "gpt-3.5-turbo-0613",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content:
                  "The capital of France is Paris. Paris is not only the political capital but also the cultural and economic center of France. It's known for its iconic landmarks such as the Eiffel Tower, the Louvre Museum, and Notre-Dame Cathedral.",
              },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 29,
            completion_tokens: 48,
            total_tokens: 77,
          },
        });
      });
    },
  });

  const machine = {
    name: "small-1x",
    cpu: 1,
    memory: 256,
    centsPerMs: 0.0000001,
  } satisfies MachinePreset;

  try {
    const taskRunProcess = new TaskRunProcess({
      workerManifest: workerManifest!,
      cwd: destination,
      env: {
        USAGE_EVENT_URL: server.http.url("/usage").href,
        OTEL_EXPORTER_OTLP_ENDPOINT: server.http.url().origin,
        TRIGGER_JWT: "test-jwt",
        TRIGGER_SECRET_KEY: "test-secret",
        TRIGGER_API_URL: server.http.url().origin,
        USAGE_HEARTBEAT_INTERVAL_MS: "500",
        OPENAI_API_KEY: "api-key",
        OPENAI_BASE_URL: server.http.url().origin + "/v1",
      },
      serverWorker: {
        id: "test",
        version: "1.0.0",
        contentHash,
      },
      machineResources: machine,
    }).initialize();

    const result = await taskRunProcess.execute({
      payload: {
        traceContext: {
          traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        },
        environment: {},
        execution: {
          task: run.task,
          attempt: {
            id: "attempt_1234",
            status: "RUNNING",
            number: 1,
            startedAt: new Date(),
            backgroundWorkerId: "worker_1234",
            backgroundWorkerTaskId: "task_1234",
          },
          run: {
            id: "run_1234",
            startedAt: new Date(),
            payload: run.payload,
            payloadType: run.payloadType ?? "application/json",
            tags: [],
            context: {},
            isTest: false,
            createdAt: new Date(),
            durationMs: 0,
            costInCents: 0,
            baseCostInCents: 0,
            version: "1.0.0",
          },
          queue: {
            id: "queue_1234",
            name: "test",
          },
          environment: {
            type: "DEVELOPMENT",
            id: "env_1234",
            slug: "dev",
          },
          organization: {
            id: "org_1234",
            slug: "test",
            name: "test",
          },
          project: {
            id: "project_1234",
            slug: "test",
            ref: "main",
            name: "test",
          },
          machine,
        },
      },
      messageId: "run_1234",
    });

    await taskRunProcess.cleanup(true);

    return {
      result,
      usageReports,
      totalDurationMs: usageReports.reduce((acc, report) => acc + report.durationMs, 0),
      spans,
    };
  } finally {
    await server.close();
  }
}

function parseTraceBodyIntoEvents(body: any): ExecuteTaskTraceEvent[] {
  return body.resourceSpans.flatMap(parseResourceSpanIntoEvents);
}

function parseResourceSpanIntoEvents(resourceSpan: any): ExecuteTaskTraceEvent[] {
  return resourceSpan.scopeSpans.flatMap((scopeSpan: any) =>
    parseScopeSpanIntoEvents(scopeSpan, resourceSpan.resource)
  );
}

function parseScopeSpanIntoEvents(scopeSpan: any, resource: any): ExecuteTaskTraceEvent[] {
  return scopeSpan.spans.flatMap((span: any) => parseSpanInEvent(span, resource));
}

function parseSpanInEvent(span: any, resource: any): ExecuteTaskTraceEvent {
  return {
    name: span.name,
    traceId: span.traceId,
    spanId: span.spanId,
    parentSpanId: span.parentSpanId,
    durationMs: calculateSpanDurationMs(span),
    attributes: {
      ...parseAttributes(resource.attributes),
      ...parseAttributes(span.attributes),
    },
  };
}

function calculateSpanDurationMs(span: any): number {
  return Number(BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano) / BigInt(1e6));
}

function parseAttributes(attributes: any): ExecuteTaskTraceEvent["attributes"] {
  if (!attributes) return {};

  return attributes.reduce((acc: any, attribute: any) => {
    acc[attribute.key] = isStringValue(attribute.value)
      ? attribute.value.stringValue
      : isIntValue(attribute.value)
      ? Number(attribute.value.intValue)
      : isDoubleValue(attribute.value)
      ? attribute.value.doubleValue
      : isBoolValue(attribute.value)
      ? attribute.value.boolValue
      : isBytesValue(attribute.value)
      ? binaryToHex(attribute.value.bytesValue)
      : undefined;

    return acc;
  }, {});
}

function isBoolValue(value: any | undefined): value is { boolValue: boolean } {
  if (!value) return false;

  return typeof value.boolValue === "boolean";
}

function isStringValue(value: any | undefined): value is { stringValue: string } {
  if (!value) return false;

  return typeof value.stringValue === "string";
}

function isIntValue(value: any | undefined): value is { intValue: bigint } {
  if (!value) return false;

  return typeof value.intValue === "number";
}

function isDoubleValue(value: any | undefined): value is { doubleValue: number } {
  if (!value) return false;

  return typeof value.doubleValue === "number";
}

function isBytesValue(value: any | undefined): value is { bytesValue: Buffer } {
  if (!value) return false;

  return Buffer.isBuffer(value.bytesValue);
}
function binaryToHex(buffer: Buffer | string): string;
function binaryToHex(buffer: Buffer | string | undefined): string | undefined;
function binaryToHex(buffer: Buffer | string | undefined): string | undefined {
  if (!buffer) return undefined;
  if (typeof buffer === "string") return buffer;

  return Buffer.from(Array.from(buffer)).toString("hex");
}
