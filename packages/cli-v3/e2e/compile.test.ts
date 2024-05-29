import { execaNode } from "execa";
import { renameSync } from "node:fs";
import { join, resolve } from "node:path";

type TestCase = {
  name: string;
  options: string[];
};

const testCases: TestCase[] = [
  {
    name: "server-only",
    options: ["--skip-typecheck"],
  },
  {
    name: "infisical-sdk",
    options: ["--skip-typecheck"],
  },
];

for (let testCase of testCases) {
  const { options, name } = testCase;

  if (process.env.MOD && process.env.MOD !== name) continue;

  const fixtureDir = resolve(join(process.cwd(), "e2e/fixtures", name));
  const commandPath = resolve(join(process.cwd(), "dist/e2e.js"));
  const logLevel = process.env.LOG || "log";

  togglePackageManager(true, fixtureDir, process.env.PM);

  test(
    `project fixture "${testCase.name}" compiles`,
    async () => {
      await expect(
        (async () => {
          const { stdout } = await execaNode(
            commandPath,
            ["deploy-compile", fixtureDir, "--log-level", logLevel, ...options],
            { cwd: fixtureDir }
          );
          console.log(stdout);
        })()
      ).resolves.not.toThrowError();
    },
    { timeout: 60_000 }
  );

  togglePackageManager(false, fixtureDir, process.env.PM);
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
