import { execa } from "execa";
import { readFileSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { typecheckProject } from "../src/commands/deploy";
import { readConfig, ReadConfigFileResult } from "../src/utilities/configFiles";
import { compile } from "./compile";
import { Metafile } from "esbuild";
import { Loglevel, LogLevelSchema, PackageManager, PackageManagerSchema } from ".";
import { logger } from "../src/utilities/logger";

type TestCase = {
  name: string;
  skipTypecheck: boolean;
};

const allTestCases: TestCase[] = [
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

  describe.each(testCases)("fixture $name", async ({ name, skipTypecheck }: TestCase) => {
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
              const { stdout } = await execa("corepack", ["use", `${packageManager}@${version}`], {
                cwd: fixtureDir,
              });
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

    test("resolves config", async () => {
      await expect(
        (async () => {
          global.resolvedConfig = await readConfig(fixtureDir, { cwd: fixtureDir });
        })()
      ).resolves.not.toThrowError();

      expect(global.resolvedConfig).not.toBe("error");
    });

    describe("with resolved config", () => {
      test.skipIf(skipTypecheck)("typechecks", async () => {
        expect(global.resolvedConfig.status).not.toBe("error");

        await expect(
          (async () =>
            await typecheckProject((global.resolvedConfig as ReadConfigFileResult).config))()
        ).resolves.not.toThrowError();
      });

      let entrypointMetadata: Metafile["outputs"]["out/stdin.js"];
      let workerMetadata: Metafile["outputs"]["out/stdin.js"];

      test(
        "compiles",
        async () => {
          expect(global.resolvedConfig.status).not.toBe("error");

          await expect(
            (async () => {
              const { entryPointMetaOutput, metaOutput } = await compile({
                resolvedConfig: global.resolvedConfig,
              });
              entrypointMetadata = entryPointMetaOutput;
              workerMetadata = metaOutput;
            })()
          ).resolves.not.toThrowError();
        },
        { timeout: 60_000 }
      );
    });
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
