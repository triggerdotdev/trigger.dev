import { execaNode } from "execa";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";

type TestCase = {
  name: string;
};

const testCases: TestCase[] = [
  {
    name: "server-only",
  },
];

for (let testCase of testCases) {
  const { name } = testCase;
  const fixtureDir = resolve(join(process.cwd(), "test/fixtures", name));
  const commandPath = resolve(join(process.cwd(), "dist/test/compile.js"));

  test(`project fixture "${testCase.name}" compiles`, async () => {
    expect(await execaNode(commandPath, ["deploy-compile", fixtureDir])).resolves.not.toThrow();
  });
}
