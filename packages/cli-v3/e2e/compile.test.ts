import { execaNode } from "execa";
import { renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { typecheckProject } from "../src/commands/deploy";
import { readConfig } from "../src/utilities/configFiles";
import { rm } from "node:fs/promises";

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
  ? [allTestCases.find(({ name }) => process.env.MOD === name)]
  : allTestCases;

if (testCases.length > 0) {
  describe.each(testCases as TestCase[])("fixture $name", ({ name, skipTypecheck }) => {
    const fixtureDir = resolve(join(process.cwd(), "e2e/fixtures", name));
    const commandPath = resolve(join(process.cwd(), "dist/e2e.js"));
    const logLevel = process.env.LOG || "log";

    beforeAll(async () => {
      await rm(resolve(join(fixtureDir, ".trigger")), { recursive: true });
      // await rm(resolve(join(fixtureDir, "node_modules")), { recursive: true });
      // await rm(resolve(join(fixtureDir, ".pnpm_store")), { recursive: true });
    });

    test(
      "compiles",
      async () => {
        const resolvedConfig = await readConfig(fixtureDir);

        if (resolvedConfig.status === "error") {
          throw new Error(`cannot resolve config in directory ${fixtureDir}`);
        }

        if (!skipTypecheck) {
          const typecheck = await typecheckProject(resolvedConfig.config);

          if (!typecheck) {
            throw new Error("Typecheck failed, aborting deployment");
          }
        }

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
  throw new Error(`Unknown fixture ${process.env.MOD}`);
} else {
  throw new Error("Nothing to test");
}

// For now to avoid changes in codebase.
function togglePackageManager(toggle: boolean, dir: string, packageManager?: string) {
  switch (packageManager) {
    case "bun":
      renameSync(
        join(dir, `pnpm-lock${toggle ? "" : ".muted"}.yaml`),
        join(dir, `pnpm-lock${toggle ? ".muted" : ""}.yaml`)
      );
      renameSync(
        join(dir, `yarn${toggle ? "" : ".muted"}.lock`),
        join(dir, `yarn${toggle ? ".muted" : ""}.lock`)
      );
      renameSync(
        join(dir, `package-lock${toggle ? "" : ".muted"}.json`),
        join(dir, `package-lock${toggle ? ".muted" : ""}.json`)
      );
      break;
    case "pnpm":
      renameSync(
        join(dir, `bun${toggle ? "" : ".muted"}.lockb`),
        join(dir, `bun${toggle ? ".muted" : ""}.lockb`)
      );
      renameSync(
        join(dir, `yarn${toggle ? "" : ".muted"}.lock`),
        join(dir, `yarn${toggle ? ".muted" : ""}.lock`)
      );
      renameSync(
        join(dir, `package-lock${toggle ? "" : ".muted"}.json`),
        join(dir, `package-lock${toggle ? ".muted" : ""}.json`)
      );
      break;
    case "yarn":
      renameSync(
        join(dir, `bun${toggle ? "" : ".muted"}.lockb`),
        join(dir, `bun${toggle ? ".muted" : ""}.lockb`)
      );
      renameSync(
        join(dir, `pnpm-lock${toggle ? "" : ".muted"}.yaml`),
        join(dir, `pnpm-lock${toggle ? ".muted" : ""}.yaml`)
      );
      renameSync(
        join(dir, `package-lock${toggle ? "" : ".muted"}.json`),
        join(dir, `package-lock${toggle ? ".muted" : ""}.json`)
      );
      break;
    case "npm":
    default:
      renameSync(
        join(dir, `pnpm-lock${toggle ? "" : ".muted"}.yaml`),
        join(dir, `pnpm-lock${toggle ? ".muted" : ""}.yaml`)
      );
      renameSync(
        join(dir, `bun${toggle ? "" : ".muted"}.lockb`),
        join(dir, `bun${toggle ? ".muted" : ""}.lockb`)
      );
      renameSync(
        join(dir, `yarn${toggle ? "" : ".muted"}.lock`),
        join(dir, `yarn${toggle ? ".muted" : ""}.lock`)
      );
      break;
  }
}
