import { execa } from "execa";
import { readFileSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { typecheckProject } from "../src/commands/deploy";
import { readConfig, ReadConfigFileResult } from "../src/utilities/configFiles";
import { compile } from "./compile";
import { Loglevel, LogLevelSchema, PackageManager, PackageManagerSchema } from ".";
import { logger } from "../src/utilities/logger";
import { handleDependencies } from "./handleDependencies";

type TestCase = {
  name: string;
  skipTypecheck?: boolean;
  wantConfigNotFoundError?: boolean;
  wantBadConfigError?: boolean;
  wantCompilationError?: boolean;
  wantDependenciesError?: boolean;
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
  {
    name: "infisical-sdk",
    skipTypecheck: true,
  },
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
      wantDependenciesError,
    }: TestCase) => {
      const fixtureDir = resolve(join(process.cwd(), "e2e/fixtures", name));

      beforeAll(async () => {
        await rm(resolve(join(fixtureDir, ".trigger")), { force: true, recursive: true });
        await rm(resolve(join(fixtureDir, "node_modules")), { force: true, recursive: true });
        if (packageManager === "npm") {
          // `npm ci` & `npm install` will update an existing yarn.lock
          await rename(
            resolve(join(fixtureDir, "yarn.lock")),
            resolve(join(fixtureDir, "yarn.lock.copy"))
          );
        }
      });

      afterAll(async () => {
        if (packageManager === "npm") {
          await rename(
            resolve(join(fixtureDir, "yarn.lock.copy")),
            resolve(join(fixtureDir, "yarn.lock"))
          );
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
                const { stdout } = await execa(
                  "corepack",
                  ["use", `${packageManager}@${version}`],
                  {
                    cwd: fixtureDir,
                  }
                );
                console.log(stdout);
              } else {
                const { stdout } = await execa(packageManager, installArgs(packageManager), {
                  cwd: fixtureDir,
                });
                console.log(stdout);
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
          expect(global.resolvedConfig!.status).not.toBe("error");

          await expect(
            (async () =>
              await typecheckProject((global.resolvedConfig as ReadConfigFileResult).config))()
          ).resolves.not.toThrowError();
        });

        test(
          wantCompilationError ? "does not compile" : "compiles",
          async () => {
            expect(global.resolvedConfig!.status).not.toBe("error");

            const expectation = expect(
              (async () => {
                const { entryPointMetaOutput, metaOutput } = await compile({
                  resolvedConfig: global.resolvedConfig!,
                  tempDir: global.tempDir!,
                });
                global.entryPointMetaOutput = entryPointMetaOutput;
                global.metaOutput = metaOutput;
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
            delete global.metaOutput;
          });

          test(
            wantDependenciesError ? "does not resolve dependencies" : "resolves dependencies",
            async () => {
              const expectation = expect(
                (async () => {
                  await handleDependencies({
                    entryPointMetaOutput: global.entryPointMetaOutput!,
                    metaOutput: global.metaOutput!,
                    resolvedConfig: global.resolvedConfig!,
                    tempDir: global.tempDir!,
                  });
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
