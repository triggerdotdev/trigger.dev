import { execa, execaNode } from "execa";
import { mkdir, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { Loglevel, LogLevelSchema, PackageManagerSchema } from "./schemas";
import { typecheckProject } from "../src/commands/deploy";
import { readConfig, ReadConfigFileResult } from "../src/utilities/configFiles";
import { PackageManager } from "../src/utilities/getUserPackageManager";
import { logger } from "../src/utilities/logger";
import { compile } from "./compile";
import { handleDependencies } from "./handleDependencies";
import { createContainerFile } from "./createContainerFile";
import { createDeployHash } from "./createDeployHash";
import { readFileSync } from "node:fs";

type TestCase = {
  name: string;
  skipTypecheck?: boolean;
  wantConfigNotFoundError?: boolean;
  wantBadConfigError?: boolean;
  wantCompilationError?: boolean;
  wantWorkerError?: boolean;
  wantDependenciesError?: boolean;
  wantInstallationError?: boolean;
};

const allTestCases: TestCase[] = [
  {
    name: "no-config",
    wantConfigNotFoundError: true,
  },
  {
    name: "server-only",
    skipTypecheck: true,
  },
  // {
  //   name: "infisical-sdk",
  //   skipTypecheck: true,
  // },
];

const testCases = process.env.MOD
  ? allTestCases.filter(({ name }) => process.env.MOD === name)
  : allTestCases;

let logLevel: Loglevel = "log";
let packageManager: PackageManager = "npm";

try {
  logLevel = LogLevelSchema.parse(process.env.LOG);
} catch (e) {
  console.error(e);
  console.log("Using default log level 'log'");
}

logger.loggerLevel = logLevel;

try {
  packageManager = PackageManagerSchema.parse(process.env.PM);
} catch (e) {
  console.error(e);
  console.log("Using default package manager 'npm'");
}

if (testCases.length > 0) {
  console.log(`Using ${packageManager}`);

  describe.each(testCases)(
    "fixture $name",
    async ({
      name,
      skipTypecheck,
      wantConfigNotFoundError,
      wantBadConfigError,
      wantCompilationError,
      wantWorkerError,
      wantDependenciesError,
      wantInstallationError,
    }: TestCase) => {
      const fixtureDir = resolve(join(process.cwd(), "e2e/fixtures", name));

      beforeAll(async () => {
        await rm(resolve(join(fixtureDir, ".trigger")), { force: true, recursive: true });
        await rm(resolve(join(fixtureDir, "node_modules")), { force: true, recursive: true });
        if (packageManager === "npm") {
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
      });

      afterAll(async () => {
        if (packageManager === "npm") {
          try {
            await rename(
              resolve(join(fixtureDir, "yarn.lock.copy")),
              resolve(join(fixtureDir, "yarn.lock"))
            );
          } catch {}
        }
      });

      test(
        "installs",
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
            })()
          ).resolves.not.toThrowError();
        },
        { timeout: 60_000 }
      );

      test(
        wantConfigNotFoundError || wantBadConfigError
          ? "does not resolve config"
          : "resolves config",
        async () => {
          const expectation = expect(
            (async () => {
              global.resolvedConfig = await readConfig(fixtureDir, { cwd: fixtureDir });
            })()
          );
          if (wantConfigNotFoundError) {
            await expectation.rejects.toThrowError();
          } else {
            await expectation.resolves.not.toThrowError();
          }

          if (wantBadConfigError) {
            expect(global.resolvedConfig).toBe("error");
          } else {
            expect(global.resolvedConfig).not.toBe("error");
          }
        }
      );

      describe.skipIf(wantConfigNotFoundError || wantBadConfigError)("with resolved config", () => {
        beforeAll(async () => {
          global.tempDir = await mkdir(
            join((global.resolvedConfig as ReadConfigFileResult).config.projectDir, ".trigger"),
            { recursive: true }
          );
        });

        afterAll(() => {
          delete global.tempDir;
          delete global.resolvedConfig;
        });

        test.skipIf(skipTypecheck)("typechecks", async () => {
          await expect(
            (async () =>
              await typecheckProject((global.resolvedConfig as ReadConfigFileResult).config))()
          ).resolves.not.toThrowError();
        });

        test(
          wantCompilationError ? "does not compile" : "compiles",
          async () => {
            const expectation = expect(
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
              })()
            );

            if (wantCompilationError) {
              await expectation.rejects.toThrowError();
            } else {
              await expectation.resolves.not.toThrowError();
            }
          },
          { timeout: 60_000 }
        );

        describe.skipIf(wantCompilationError)("with successful compilation", () => {
          afterAll(() => {
            delete global.entryPointMetaOutput;
            delete global.entryPointOutputFile;
            delete global.workerMetaOutput;
            delete global.workerOutputFile;
          });

          test(
            wantDependenciesError ? "does not resolve dependencies" : "resolves dependencies",
            async () => {
              const expectation = expect(
                (async () => {
                  const { dependencies } = await handleDependencies({
                    entryPointMetaOutput: global.entryPointMetaOutput!,
                    metaOutput: global.workerMetaOutput!,
                    resolvedConfig: global.resolvedConfig!,
                    tempDir: global.tempDir!,
                    packageManager,
                  });
                  global.dependencies = dependencies;
                })()
              );

              if (wantDependenciesError) {
                await expectation.rejects.toThrowError();
              } else {
                await expectation.resolves.not.toThrowError();
              }
            },
            { timeout: 60_000 }
          );

          describe.skipIf(wantDependenciesError)("with resolved dependencies", () => {
            afterAll(() => {
              delete global.dependencies;
            });

            test("copies postinstall command into Containerfile.prod", async () => {
              await expect(
                (async () => {
                  await createContainerFile({
                    resolvedConfig: global.resolvedConfig!,
                    tempDir: global.tempDir!,
                  });
                })()
              ).resolves.not.toThrowError();
            });

            test("creates deploy hash", async () => {
              await expect(
                (async () => {
                  await createDeployHash({
                    dependencies: global.dependencies!,
                    entryPointOutputFile: global.entryPointOutputFile!,
                    workerOutputFile: global.workerOutputFile!,
                  });
                })()
              ).resolves.not.toThrowError();
            });

            describe("with Containerfile ready", () => {
              test(
                "installs dependencies",
                async () => {
                  const expectation = expect(
                    (async () => {
                      const { stdout, stderr } = await execa(
                        "npm",
                        ["ci", "--no-audit", "--no-fund"],
                        {
                          cwd: resolve(join(fixtureDir, ".trigger")),
                        }
                      );
                      console.log(stdout);
                      if (stderr) console.error(stderr);
                    })()
                  );

                  if (wantInstallationError) {
                    await expectation.rejects.toThrowError();
                  } else {
                    await expectation.resolves.not.toThrowError();
                  }
                },
                { timeout: 60_000 }
              );

              test(
                wantWorkerError ? "'node worker.js' fails" : "'node worker.js' succeeds",
                async () => {
                  const expectation = expect(
                    (async () => {
                      const { stdout, stderr } = await execaNode("worker.js", {
                        cwd: resolve(join(fixtureDir, ".trigger")),
                      });
                      console.log(stdout);
                      if (stderr) console.error(stderr);
                    })()
                  );

                  if (wantWorkerError) {
                    await expectation.rejects.toThrowError();
                  } else {
                    await expectation.resolves.not.toThrowError();
                  }
                },
                { timeout: 60_000 }
              );
            });
          });
        });
      });
    }
  );
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
