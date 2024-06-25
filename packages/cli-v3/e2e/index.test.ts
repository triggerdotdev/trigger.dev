import { execa, execaNode } from "execa";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { rimraf } from "rimraf";

import { typecheckProject } from "../src/commands/deploy";
import { readConfig, ReadConfigFileResult, ReadConfigResult } from "../src/utilities/configFiles";
import {
  detectPackageManagerFromArtifacts,
  LOCKFILES,
  PackageManager,
} from "../src/utilities/getUserPackageManager";
import { logger } from "../src/utilities/logger";
import { compile } from "./compile";
import { createContainerFile } from "./createContainerFile";
import { createDeployHash } from "./createDeployHash";
import { handleDependencies } from "./handleDependencies";
import { E2EOptions, E2EOptionsSchema } from "./schemas";
import { fixturesConfig, TestCase } from "./fixtures.config";
import { Metafile, OutputFile } from "esbuild";

interface E2EFixtureTest extends TestCase {
  dir: string;
  packageManager: PackageManager;
  tempDir: string;
}

const TIMEOUT = 120_000;

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

if (testCases.length > 0) {
  describe.concurrent("bundling", async () => {
    beforeEach<E2EFixtureTest>(async ({ dir, packageManager }) => {
      await rimraf(join(dir, "**/node_modules/**"), {
        glob: true,
      });
      await rimraf(join(dir, ".yarn"), { glob: true });
      if (
        packageManager === "npm" &&
        (existsSync(resolve(join(dir, "yarn.lock"))) ||
          existsSync(resolve(join(dir, "yarn.lock.copy"))))
      ) {
        // `npm ci` & `npm install` will update an existing yarn.lock
        try {
          await rename(resolve(join(dir, "yarn.lock")), resolve(join(dir, "yarn.lock.copy")));
        } catch (e) {
          await rename(resolve(join(dir, "yarn.lock.copy")), resolve(join(dir, "yarn.lock")));
        }
      }

      await installFixtureDeps(dir, packageManager);
    }, TIMEOUT);

    afterEach<E2EFixtureTest>(async ({ dir, packageManager }) => {
      if (packageManager === "npm") {
        try {
          await rename(resolve(join(dir, "yarn.lock.copy")), resolve(join(dir, "yarn.lock")));
        } catch {}
      }

      vi.unstubAllEnvs();
    });

    for (let testCase of testCases) {
      test.extend<E2EFixtureTest>({
        ...testCase,
        dir: async ({ id }, use) => await use(resolve(join(process.cwd(), "e2e/fixtures", id))),
        packageManager: async ({ dir }, use) => await use(await parsePackageManager(options, dir)),
        tempDir: async ({ dir }, use) => {
          const existingTempDir = resolve(join(dir, ".trigger"));

          if (existsSync(existingTempDir)) {
            await rm(existingTempDir, { force: true, recursive: true });
          }
          await use((await mkdir(join(dir, ".trigger"), { recursive: true })) as string);
        },
      })(
        `fixture '${testCase.id}'`,
        { timeout: TIMEOUT },
        async ({
          dir,
          packageManager,
          resolveEnv,
          skip,
          skipTypecheck,
          tempDir,
          wantCompilationError,
          wantConfigInvalidError,
          wantConfigNotFoundError,
          wantDependenciesError,
          wantInstallationError,
          wantWorkerError,
        }) => {
          if (
            options.packageManager &&
            !existsSync(resolve(dir, LOCKFILES[options.packageManager]))
          ) {
            skip();
          }

          let resolvedConfig: ReadConfigResult;
          const configExpect = expect(
            (async () => {
              resolvedConfig = await readConfig(dir, { cwd: dir });
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
            expect(resolvedConfig!.status).toBe("error");
            return;
          }

          expect(resolvedConfig!).not.toBe("error");

          if (!skipTypecheck) {
            await expect(
              (async () =>
                await typecheckProject((resolvedConfig! as ReadConfigFileResult).config))(),
              "typechecks"
            ).resolves.not.toThrowError();
          }

          let entryPointMetaOutput: Metafile["outputs"]["out/stdin.js"];
          let entryPointOutputFile: OutputFile;
          let workerMetaOutput: Metafile["outputs"]["out/stdin.js"];
          let workerOutputFile: OutputFile;

          const compileExpect = expect(
            (async () => {
              const compilationResult = await compile({
                resolvedConfig: resolvedConfig!,
                tempDir,
              });
              entryPointMetaOutput = compilationResult.entryPointMetaOutput;
              entryPointOutputFile = compilationResult.entryPointOutputFile;
              workerMetaOutput = compilationResult.workerMetaOutput;
              workerOutputFile = compilationResult.workerOutputFile;
            })(),
            wantCompilationError ? "does not compile" : "compiles"
          );

          if (wantCompilationError) {
            await compileExpect.rejects.toThrowError();
            return;
          }

          await compileExpect.resolves.not.toThrowError();

          let dependencies: { [k: string]: string };

          if (resolveEnv) {
            for (let envKey in resolveEnv) {
              vi.stubEnv(envKey, resolveEnv[envKey]!);
            }
          }

          const depsExpectation = expect(
            (async () => {
              dependencies = await handleDependencies({
                entryPointMetaOutput: entryPointMetaOutput!,
                metaOutput: workerMetaOutput!,
                resolvedConfig: resolvedConfig!,
                tempDir,
                packageManager,
              });
            })(),
            wantDependenciesError ? "does not resolve dependencies" : "resolves dependencies"
          );

          if (wantDependenciesError) {
            await depsExpectation.rejects.toThrowError();
            return;
          }

          await depsExpectation.resolves.not.toThrowError();

          if (resolveEnv) {
            vi.unstubAllEnvs();
          }

          await expect(
            (async () => {
              await createContainerFile({
                resolvedConfig: resolvedConfig!,
                tempDir,
              });
            })(),
            "copies postinstall command into Containerfile.prod"
          ).resolves.not.toThrowError();

          await expect(
            (async () => {
              await createDeployHash({
                dependencies: dependencies!,
                entryPointOutputFile: entryPointOutputFile!,
                workerOutputFile: workerOutputFile!,
              });
            })(),
            "creates deploy hash"
          ).resolves.not.toThrowError();

          const installBundleDepsExpect = expect(
            (async () => {
              const { stdout: installStdout, stderr: installStderr } = await execa(
                "npm",
                ["ci", "--no-audit", "--no-fund"],
                {
                  cwd: tempDir,
                  NODE_PATH: resolve(join(tempDir, "node_modules")),
                }
              );
              console.log(installStdout);
              if (installStderr) console.error(installStderr);
            })(),
            wantInstallationError ? "does not install dependencies" : "installs dependencies"
          );

          if (wantInstallationError) {
            await installBundleDepsExpect.rejects.toThrowError();
            return;
          }

          await installBundleDepsExpect.resolves.not.toThrowError();

          const workerStartExpect = expect(
            (async () => {
              const { stdout, stderr } = await execaNode("worker.js", {
                cwd: tempDir,
                env: {
                  // Since we don't start the worker in a container, limit node resolution algorithm to the '.trigger/node_modules' folder
                  NODE_PATH: resolve(join(tempDir, "node_modules")),
                },
              });
              console.log(stdout);
              if (stderr) console.error(stderr);
            })(),
            wantWorkerError ? "worker does not start" : "worker starts"
          );

          if (wantWorkerError) {
            await workerStartExpect.rejects.toThrowError();
            return;
          }

          await workerStartExpect.resolves.not.toThrowError();
        }
      );
    }
  });
} else if (process.env.MOD) {
  throw new Error(`Unknown fixture '${process.env.MOD}'`);
} else {
  throw new Error("Nothing to test");
}

async function installFixtureDeps(dir: string, packageManager: PackageManager) {
  if (["pnpm", "yarn"].includes(packageManager)) {
    const buffer = readFileSync(resolve(join(dir, "package.json")), "utf8");
    const pkgJSON = JSON.parse(buffer.toString());
    const version = pkgJSON.engines[packageManager];
    console.log(`Detected ${packageManager}@${version} from package.json 'engines' field`);
    const { stdout, stderr } = await execa("corepack", ["use", `${packageManager}@${version}`], {
      cwd: dir,
    });
    console.log(stdout);
    if (stderr) console.error(stderr);
  } else {
    const { stdout, stderr } = await execa(packageManager, installArgs(packageManager), {
      cwd: dir,
      NODE_PATH: resolve(join(dir, "node_modules")),
    });
    console.log(stdout);
    if (stderr) console.error(stderr);
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

async function parsePackageManager(
  options: E2EOptions,
  fixtureDir: string
): Promise<PackageManager> {
  let packageManager: PackageManager;

  if (options.packageManager) {
    packageManager = options.packageManager;
  } else {
    packageManager = await detectPackageManagerFromArtifacts(fixtureDir);
  }

  return packageManager;
}
