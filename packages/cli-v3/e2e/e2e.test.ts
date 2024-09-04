import { BuildManifest, WorkerManifest } from "@trigger.dev/core/v3/schemas";
import * as fs from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import * as path from "node:path";
import { rimraf } from "rimraf";
import { buildWorker } from "../src/build/buildWorker.js";
import { loadConfig } from "../src/config.js";
import { indexWorkerManifest } from "../src/indexing/indexWorkerManifest.js";
import { writeJSONFile } from "../src/utilities/fileSystem.js";
import { logger } from "../src/utilities/logger.js";
import { getTmpDir } from "../src/utilities/tempDirectories.js";
import { fixturesConfig, TestCase } from "./fixtures.js";
import { E2EOptions, E2EOptionsSchema } from "./schemas.js";
import { executeTestCaseRun, runTsc } from "./utils.js";
import { installFixtureDeps, LOCKFILES, PackageManager, parsePackageManager } from "./utils.js";

const TIMEOUT = 120_000;

interface E2EFixtureTest extends TestCase {
  fixtureDir: string;
  packageManager: PackageManager;
  tempDir: string;
  workspaceDir: string;
}

const testCases: TestCase[] = process.env.MOD
  ? fixturesConfig.filter(({ id }) => process.env.MOD === id)
  : fixturesConfig;

let options: E2EOptions;

try {
  options = E2EOptionsSchema.parse({
    logLevel: process.env.LOG,
    packageManager: process.env.PM,
  });
} catch (e) {
  options = {
    logLevel: "log",
  };
}

logger.loggerLevel = options.logLevel;

if (testCases.length === 0) {
  if (process.env.MOD) {
    throw new Error(`No test case found for ${process.env.MOD}`);
  } else {
    throw new Error("Nothing to test");
  }
}

describe.concurrent("buildWorker", async () => {
  beforeEach<E2EFixtureTest>(async ({ fixtureDir, skip, packageManager, workspaceDir }) => {
    await rimraf(path.join(workspaceDir, "**/node_modules"), {
      glob: true,
    });

    await rimraf(path.join(workspaceDir, ".yarn"), { glob: true });

    if (
      packageManager === "npm" &&
      (fs.existsSync(path.resolve(path.join(workspaceDir, "yarn.lock"))) ||
        fs.existsSync(path.resolve(path.join(workspaceDir, "yarn.lock.copy"))))
    ) {
      // `npm ci` & `npm install` will update an existing yarn.lock
      try {
        await rename(
          path.resolve(path.join(workspaceDir, "yarn.lock")),
          path.resolve(path.join(workspaceDir, "yarn.lock.copy"))
        );
      } catch (e) {
        await rename(
          path.resolve(path.join(workspaceDir, "yarn.lock.copy")),
          path.resolve(path.join(workspaceDir, "yarn.lock"))
        );
      }
    }

    if (
      options.packageManager &&
      !fs.existsSync(path.resolve(fixtureDir, LOCKFILES[options.packageManager]))
    ) {
      skip();
    }

    await installFixtureDeps({ fixtureDir, packageManager, workspaceDir });
  }, TIMEOUT);

  afterEach<E2EFixtureTest>(async ({ packageManager, workspaceDir }) => {
    if (packageManager === "npm") {
      try {
        await rename(
          path.resolve(path.join(workspaceDir, "yarn.lock.copy")),
          path.resolve(path.join(workspaceDir, "yarn.lock"))
        );
      } catch {}
    }

    vi.unstubAllEnvs();
  });

  for (let testCase of testCases) {
    test.extend<E2EFixtureTest>({
      ...testCase,
      fixtureDir: async ({ id }, use) =>
        await use(path.resolve(path.join(process.cwd(), "e2e/fixtures", id))),
      workspaceDir: async ({ fixtureDir, workspaceRelativeDir = "" }, use) =>
        await use(path.resolve(path.join(fixtureDir, workspaceRelativeDir))),
      packageManager: async ({ workspaceDir }, use) =>
        await use(await parsePackageManager(options.packageManager, workspaceDir)),
      tempDir: async ({ workspaceDir }, use) => {
        const existingTempDir = path.resolve(path.join(workspaceDir, ".trigger"));

        if (fs.existsSync(existingTempDir)) {
          await rm(existingTempDir, { force: true, recursive: true });
        }
        await use(
          (await mkdir(path.join(workspaceDir, ".trigger"), { recursive: true })) as string
        );
      },
    })(
      `fixture ${testCase.id}`,
      { timeout: TIMEOUT },
      async ({
        id,
        tempDir,
        tsconfig,
        workspaceDir,
        wantConfigInvalidError,
        wantConfigNotFoundError,
        wantBuildWorkerError,
        wantIndexingError,
        buildManifestMatcher,
        workerManifestMatcher,
        runs,
      }) => {
        let resolvedConfig: Awaited<ReturnType<typeof loadConfig>>;

        const configExpect = expect(
          (async () => {
            resolvedConfig = await loadConfig({
              cwd: workspaceDir,
            });
          })(),
          wantConfigNotFoundError || wantConfigInvalidError
            ? "does not resolve config"
            : "resolves config"
        );

        if (wantConfigNotFoundError) {
          await configExpect.rejects.toThrowError();
          return;
        }

        await configExpect.resolves.not.toThrowError();

        if (wantConfigInvalidError) {
          expect(resolvedConfig!).toBeUndefined();
          return;
        }

        expect(resolvedConfig!).toBeTruthy();

        if (tsconfig) {
          const tscResult = await runTsc(workspaceDir, tsconfig);

          expect(tscResult.success).toBe(true);
        }

        const destination = getTmpDir(workspaceDir, "build");

        let buildManifest: BuildManifest;

        const buildExpect = expect(
          (async () => {
            buildManifest = await buildWorker({
              target: "deploy",
              environment: "test",
              destination: destination.path,
              resolvedConfig: resolvedConfig!,
              rewritePaths: false,
            });
          })(),
          wantBuildWorkerError ? "does not build" : "builds"
        );

        if (wantBuildWorkerError) {
          await buildExpect.rejects.toThrowError();
          return;
        }

        await buildExpect.resolves.not.toThrowError();

        if (buildManifestMatcher) {
          expect(buildManifest!).toMatchObject(buildManifestMatcher);
        } else {
          expect(buildManifest!).toBeTruthy();
        }

        logger.debug("Build manifest", buildManifest!);

        const stdout: string[] = [];
        const stderr: string[] = [];

        let workerManifest: WorkerManifest;

        const indexExpect = expect(
          (async () => {
            workerManifest = await indexWorkerManifest({
              runtime: buildManifest!.runtime,
              indexWorkerPath: buildManifest!.indexWorkerEntryPoint,
              buildManifestPath: path.join(destination.path, "build.json"),
              nodeOptions: buildManifest!.loaderEntryPoint
                ? `--import=${buildManifest!.loaderEntryPoint}`
                : undefined,
              env: {},
              otelHookExclude: buildManifest!.otelImportHook?.exclude,
              otelHookInclude: buildManifest!.otelImportHook?.include,
              handleStdout(data) {
                stdout.push(data);
                logger.debug(data);
              },
              handleStderr(data) {
                if (!data.includes("DeprecationWarning")) {
                  stderr.push(data);
                  logger.debug(data);
                }
              },
            });
          })(),
          wantIndexingError ? "does not index" : "indexes"
        );

        if (wantIndexingError) {
          await indexExpect.rejects.toThrowError();
          return;
        }

        await indexExpect.resolves.not.toThrowError();

        if (workerManifestMatcher) {
          expect(workerManifest!).toMatchObject(workerManifestMatcher);
        } else {
          expect(workerManifest!).toBeTruthy();
        }

        if (runs && runs.length > 0) {
          await writeJSONFile(path.join(destination.path, "index.json"), workerManifest!);
        }

        for (const taskRun of runs || []) {
          const { result, totalDurationMs } = await executeTestCaseRun({
            run: taskRun,
            testCase,
            destination: destination.path,
            workerManifest: workerManifest!,
            contentHash: buildManifest!.contentHash,
          });

          expect(result.ok).toBe(taskRun.result.ok);

          if (taskRun.result.durationMs) {
            expect(totalDurationMs).toBeGreaterThanOrEqual(taskRun.result.durationMs);
          }
        }
      }
    );
  }
});
