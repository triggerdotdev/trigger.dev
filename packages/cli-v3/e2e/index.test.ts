import { execa, execaNode } from "execa";
import { join, resolve } from "node:path";
import { typecheckProject } from "../src/commands/deploy";
import { readConfig } from "../src/utilities/configFiles";
import { rename, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";

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

const commandPath = resolve(join(process.cwd(), "dist/e2e.js"));
const logLevel = process.env.LOG || "log";
const packageManager = process.env.PM || "npm";

if (testCases.length > 0) {
  console.log(`Using ${packageManager}`);

  describe.each(testCases)("fixture $name", async ({ name, skipTypecheck }) => {
    const fixtureDir = resolve(join(process.cwd(), "e2e/fixtures", name));
    const resolvedConfig = await readConfig(fixtureDir);

    if (resolvedConfig.status === "error") {
      throw new Error(`cannot resolve config in directory ${fixtureDir}`);
    }

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

    if (!skipTypecheck) {
      test("typechecks", async () => {
        await expect(
          (async () => await typecheckProject(resolvedConfig.config))()
        ).resolves.not.toThrowError();
      });
    }

    test(
      "compiles",
      async () => {
        let compileArgs = ["deploy-compile", fixtureDir, "--log-level", logLevel];
        if (skipTypecheck) compileArgs.push("--skip-typecheck");

        await expect(
          (async () => {
            const { stdout } = await execaNode(commandPath, compileArgs, { cwd: fixtureDir });
            console.log(stdout);
          })()
        ).resolves.not.toThrowError();
      },
      { timeout: 60_000 }
    );
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
