import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";

const monorepoRoot = resolve(__dirname, "../../..");
const vitestCli = resolve(monorepoRoot, "node_modules/vitest/vitest.mjs");
const projectHelper = pathToFileURL(resolve(monorepoRoot, "internal-test-projects.mts")).href;

test("replays named project blobs into a nonempty JSON report without package dependencies", () => {
  const root = mkdtempSync(resolve(tmpdir(), "internal-report-merge-"));
  try {
    const projects = ["first", "second"].map((name) => {
      const directory = resolve(root, "internal-packages", name);
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        resolve(directory, "package.json"),
        JSON.stringify({ name: `@internal/${name}`, scripts: { test: "vitest" } })
      );
      writeFileSync(
        resolve(directory, "vitest.config.mjs"),
        "export default { test: { globals: true } };"
      );
      writeFileSync(
        resolve(directory, "example.test.js"),
        "test('passes', () => expect(2 + 2).toBe(4));"
      );
      return directory;
    });
    writeFileSync(
      resolve(root, "run.config.mjs"),
      `export default { test: { projects: ${JSON.stringify(projects)} } };`
    );
    writeFileSync(
      resolve(root, "merge.config.mjs"),
      `import { getInternalTestReportConfig } from ${JSON.stringify(projectHelper)};
export default getInternalTestReportConfig(${JSON.stringify(root)});`
    );
    const run = (args: string[]) =>
      execFileSync(process.execPath, [vitestCli, "run", ...args], {
        cwd: root,
        encoding: "utf8",
        timeout: 10_000,
      });
    run(["--config=run.config.mjs", "--maxWorkers=1", "--reporter=blob"]);
    run([
      "--config=merge.config.mjs",
      "--merge-reports",
      "--reporter=json",
      "--outputFile.json=results.json",
    ]);
    const merged = JSON.parse(readFileSync(resolve(root, "results.json"), "utf8"));
    expect(merged.success).toBe(true);
    expect(merged.numPassedTests).toBe(2);
    expect(merged.testResults.map((file: { name: string }) => file.name).sort()).toEqual(
      projects.map((directory) => resolve(directory, "example.test.js")).sort()
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
