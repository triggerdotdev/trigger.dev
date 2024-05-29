import { execaNode } from "execa";
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

  test(
    `project fixture "${testCase.name}" compiles`,
    async () => {
      await expect(
        (async () => {
          const { stdout } = await execaNode(
            commandPath,
            ["deploy-compile", fixtureDir, ...options],
            { cwd: fixtureDir }
          );
          console.log(stdout);
        })()
      ).resolves.not.toThrowError();
    },
    { timeout: 60_000 }
  );
}
