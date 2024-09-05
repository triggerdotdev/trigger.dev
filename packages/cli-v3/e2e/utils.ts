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
  tsconfigName: string = "tsconfig.json"
): Promise<TscResult> {
  const tsconfigPath = nodePath.join(cwd, tsconfigName);
  const tscPath = nodePath.join(cwd, "node_modules", ".bin", "tsc");

  // Ensure the tsconfig file exists
  try {
    await access(tsconfigPath);
  } catch (error) {
    throw new Error(`TSConfig file not found: ${tsconfigPath}`);
  }

  try {
    const result = await execa(tscPath, ["--project", tsconfigPath, "--noEmit"], {
      cwd,
      reject: false,
    });

    const success = result.exitCode === 0;
    const errors = success ? [] : parseTypeScriptErrors(result.stderr);

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
};

export async function executeTestCaseRun({
  run,
  testCase,
  destination,
  workerManifest,
  contentHash,
}: ExecuteTaskCaseRunOptions): Promise<ExecuteTaskRunResult> {
  const usageReports: Array<ExecuteTaskRunUsageReport> = [];

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
        // TODO: Implement trace endpoint
        return Response.json({});
      });
      router.post("/v1/logs", () => {
        // TODO: Implement logs endpoint
        return Response.json({});
      });
    },
  });

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
      },
      serverWorker: {
        id: "test",
        version: "1.0.0",
        contentHash,
      },
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
        },
      },
      messageId: "run_1234",
    });

    await taskRunProcess.initialize();

    const result = await taskRunProcess.execute();

    await taskRunProcess.cleanup(true);

    return {
      result,
      usageReports,
      totalDurationMs: usageReports.reduce((acc, report) => acc + report.durationMs, 0),
    };
  } finally {
    await server.close();
  }
}
