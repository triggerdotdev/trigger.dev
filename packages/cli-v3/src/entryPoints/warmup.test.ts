import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WARMUP_FLAG } from "./warmupCommand.js";

const runWorker = join(import.meta.dirname, "managed-run-worker.ts");
// Resolved here, as the worker runs from a directory that cannot see this package's dependencies
const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;

// The marker files a module writes when it is imported, or when a task or the init file runs
async function writeProject(dir: string, lastTask: string) {
  const mark = (name: string) =>
    `(await import("node:fs")).writeFileSync(${JSON.stringify(join(dir, name))}, "");`;

  await writeFile(join(dir, "config.mjs"), `${mark("config")}\nexport default {};`);
  await writeFile(join(dir, "init.mjs"), mark("init"));
  await writeFile(
    join(dir, "a.mjs"),
    `${mark("a")}\nexport const run = async () => { ${mark("ran")} };`
  );
  await writeFile(join(dir, "b.mjs"), `${mark("b")}\n${lastTask}`);
  await writeFile(
    join(dir, "index.json"),
    JSON.stringify({
      configPath: join(dir, "config.mjs"),
      initEntryPoint: join(dir, "init.mjs"),
      workerEntryPoint: runWorker,
      runtime: "node-24",
      tasks: [
        { id: "a", filePath: "a.ts", entryPoint: join(dir, "a.mjs") },
        { id: "b", filePath: "b.ts", entryPoint: join(dir, "b.mjs") },
      ],
    })
  );
}

function warmup(dir: string) {
  return spawnSync(
    process.execPath,
    ["--import", tsx, runWorker, WARMUP_FLAG, dir],
    // No env beyond PATH, and a working directory that is not the project's
    { cwd: tmpdir(), env: { PATH: process.env.PATH }, encoding: "utf8", timeout: 60_000 }
  );
}

describe("run worker warmup", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "trigger-warmup-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // Catches: the warmup running a task or the init file, or missing a task file a run imports
  it("imports the config and every task file without running anything", async () => {
    await writeProject(dir, "export const done = true;");

    const result = warmup(dir);

    expect(result.status, result.stderr).toBe(0);
    expect(["config", "a", "b"].filter((name) => existsSync(join(dir, name)))).toEqual([
      "config",
      "a",
      "b",
    ]);
    expect(existsSync(join(dir, "init"))).toBe(false);
    expect(existsSync(join(dir, "ran"))).toBe(false);
  }, 60_000);

  // Catches: the warmup exiting 0 before a rejection the last task file queued reaches its handler
  it("fails when a task file leaves a rejected promise behind", async () => {
    await writeProject(dir, 'Promise.reject(new Error("needs an env var"));');

    const result = warmup(dir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("needs an env var");
  }, 60_000);
});
