import { execa, execaNode } from "execa";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { typecheckProject } from "../src/commands/deploy";
import { readConfig, ReadConfigFileResult } from "../src/utilities/configFiles";
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
import allTestCases from "./testCases.json";

type TestCase = {
  name: string;
  skipTypecheck?: boolean;
  wantConfigNotFoundError?: boolean;
  wantConfigInvalidError?: boolean;
  wantCompilationError?: boolean;
  wantWorkerError?: boolean;
  wantDependenciesError?: boolean;
  wantInstallationError?: boolean;
};

const TIMEOUT = 120_000;

const testCases: TestCase[] = process.env.MOD
  ? allTestCases.filter(({ name }) => process.env.MOD === name)
  : allTestCases;

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
    beforeAll(async () => {
      for (let testCase of testCases) {
        const { name } = testCase;
        const fixtureDir = resolve(join(process.cwd(), "e2e/fixtures", name));
        await rm(resolve(join(fixtureDir, ".trigger")), { force: true, recursive: true });
        await rm(resolve(join(fixtureDir, "node_modules")), { force: true, recursive: true });
        const packageManager: PackageManager = await parsepackageManager(options, fixtureDir);

        if (
          packageManager === "npm" &&
          (existsSync(resolve(join(fixtureDir, "yarn.lock"))) ||
            existsSync(resolve(join(fixtureDir, "yarn.lock.copy"))))
        ) {
          // `npm ci` & `npm install` will update an existing yarn.lock
          try {
            await rename(
              resolve(join(fixtureDir, "yarn.lock")),
              resolve(join(fixtureDir, "yarn.lock.copy"))
            );
          } catch (e) {
            await rename(
              resolve(join(fixtureDir, "yarn.lock.copy")),
              resolve(join(fixtureDir, "yarn.lock"))
            );
          }
        }
      }
    });

    afterEach(() => {
      delete global.tempDir;
      delete global.resolvedConfig;

      delete global.entryPointMetaOutput;
      delete global.entryPointOutputFile;
      delete global.workerMetaOutput;
      delete global.workerOutputFile;

      delete global.dependencies;
    });

    afterAll(async () => {
      for (let testCase of testCases) {
        const { name } = testCase;
        const fixtureDir = resolve(join(process.cwd(), "e2e/fixtures", name));
        const packageManager: PackageManager = await parsepackageManager(options, fixtureDir);

        if (packageManager === "npm") {
          try {
            await rename(
              resolve(join(fixtureDir, "yarn.lock.copy")),
              resolve(join(fixtureDir, "yarn.lock"))
            );
          } catch {}
        }
      }
    });

    for (let testCase of testCases) {
      const {
        name,
        skipTypecheck,
        wantConfigNotFoundError,
        wantConfigInvalidError,
        wantCompilationError,
        wantWorkerError,
        wantDependenciesError,
        wantInstallationError,
      } = testCase;
      const fixtureDir = resolve(join(process.cwd(), "e2e/fixtures", name));
      let shouldSkipFixture: boolean = false;
      const packageManager: PackageManager = await parsepackageManager(options, fixtureDir);

      if (options.packageManager)
        shouldSkipFixture = !existsSync(resolve(fixtureDir, LOCKFILES[options.packageManager]));

      test.skipIf(shouldSkipFixture)(
        `fixture '${name}'`,
        async () => {
          await expect(
            (async () => {
              if (["pnpm", "yarn"].includes(packageManager)) {
                const buffer = readFileSync(resolve(join(fixtureDir, "package.json")), "utf8");
                const pkgJSON = JSON.parse(buffer.toString());
                const version = pkgJSON.engines[packageManager];
                console.log(
                  `Detected ${packageManager}@${version} from package.json 'engines' field`
                );
                const { stdout, stderr } = await execa(
                  "corepack",
                  ["use", `${packageManager}@${version}`],
                  {
                    cwd: fixtureDir,
                  }
                );
                console.log(stdout);
                if (stderr) console.error(stderr);
              } else {
                const { stdout, stderr } = await execa(
                  packageManager,
                  installArgs(packageManager),
                  {
                    cwd: fixtureDir,
                  }
                );
                console.log(stdout);
                if (stderr) console.error(stderr);
              }
            })(),
            "installs fixture dependencies"
          ).resolves.not.toThrowError();

          const configExpect = expect(
            (async () => {
              global.resolvedConfig = await readConfig(fixtureDir, { cwd: fixtureDir });
            })(),
            wantConfigNotFoundError || wantConfigInvalidError
              ? "does not resolve config"
              : "resolves config"
          );
          if (wantConfigNotFoundError) {
            await configExpect.rejects.toThrowError();
          } else {
            await configExpect.resolves.not.toThrowError();
          }

          if (wantConfigNotFoundError || wantConfigInvalidError) {
            if (wantConfigInvalidError) {
              expect(global.resolvedConfig!.status).toBe("error");
            }
            return;
          }

          expect(global.resolvedConfig).not.toBe("error");

          global.tempDir = await mkdir(
            join((global.resolvedConfig as ReadConfigFileResult).config.projectDir, ".trigger"),
            { recursive: true }
          );

          if (!skipTypecheck) {
            await expect(
              (async () =>
                await typecheckProject((global.resolvedConfig as ReadConfigFileResult).config))(),
              "typechecks"
            ).resolves.not.toThrowError();
          }

          const compileExpect = expect(
            (async () => {
              const {
                workerMetaOutput,
                workerOutputFile,
                entryPointMetaOutput,
                entryPointOutputFile,
              } = await compile({
                resolvedConfig: global.resolvedConfig!,
                tempDir: global.tempDir!,
              });
              global.entryPointMetaOutput = entryPointMetaOutput;
              global.entryPointOutputFile = entryPointOutputFile;
              global.workerMetaOutput = workerMetaOutput;
              global.workerOutputFile = workerOutputFile;
            })(),
            wantCompilationError ? "does not compile" : "compiles"
          );

          if (wantCompilationError) {
            await compileExpect.rejects.toThrowError();
            return;
          }

          await compileExpect.resolves.not.toThrowError();

          const depsExpectation = expect(
            (async () => {
              const { dependencies } = await handleDependencies({
                entryPointMetaOutput: global.entryPointMetaOutput!,
                metaOutput: global.workerMetaOutput!,
                resolvedConfig: global.resolvedConfig!,
                tempDir: global.tempDir!,
                packageManager,
              });
              global.dependencies = dependencies;
            })(),
            wantDependenciesError ? "does not resolve dependencies" : "resolves dependencies"
          );

          if (wantDependenciesError) {
            await depsExpectation.rejects.toThrowError();
            return;
          }

          await depsExpectation.resolves.not.toThrowError();

          await expect(
            (async () => {
              await createContainerFile({
                resolvedConfig: global.resolvedConfig!,
                tempDir: global.tempDir!,
              });
            })(),
            "copies postinstall command into Containerfile.prod"
          ).resolves.not.toThrowError();

          await expect(
            (async () => {
              await createDeployHash({
                dependencies: global.dependencies!,
                entryPointOutputFile: global.entryPointOutputFile!,
                workerOutputFile: global.workerOutputFile!,
              });
            })(),
            "creates deploy hash"
          ).resolves.not.toThrowError();

          const installBundleDepsExpect = expect(
            (async () => {
              const { stdout, stderr } = await execa(
                "npm",
                [
                  "ci",
                  "--no-audit",
                  "--no-fund",
                  "--legacy-peer-deps=false",
                  "--strict-peer-deps=false",
                ],
                {
                  cwd: global.tempDir!,
                  NODE_PATH: resolve(join(global.tempDir!, "node_modules")),
                }
              );
              console.log(stdout);
              if (stderr) console.error(stderr);
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
                cwd: global.tempDir!,
                env: {
                  // Since we don't start the worker in a container, limit node resolution algorithm to the '.trigger/node_modules' folder
                  NODE_PATH: resolve(join(global.tempDir!, "node_modules")),
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
        },
        { timeout: TIMEOUT }
      );
    }
  });
} else if (process.env.MOD) {
  throw new Error(`Unknown fixture '${process.env.MOD}'`);
} else {
  throw new Error("Nothing to test");
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

async function parsepackageManager(
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
