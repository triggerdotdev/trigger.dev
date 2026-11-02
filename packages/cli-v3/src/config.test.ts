import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";

const projectDirs: string[] = [];

afterEach(async () => {
  await Promise.all(projectDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createProject(runtime?: string) {
  const cwd = await mkdtemp(join(tmpdir(), "trigger-runtime-config-"));
  projectDirs.push(cwd);

  await mkdir(join(cwd, "trigger"));
  await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "runtime-config-test" }));
  await writeFile(join(cwd, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await writeFile(
    join(cwd, "trigger.config.ts"),
    `export default {
  project: "proj_runtime_config_test",
  maxDuration: 60,
  dirs: ["./trigger"],
  ${runtime === undefined ? "" : `runtime: ${JSON.stringify(runtime)},`}
};
`
  );

  return cwd;
}

describe("loadConfig runtime", () => {
  it.each([
    ["node", "node-24"],
    ["node-22", "node-22"],
    ["node-24", "node-24"],
    ["node-26", "node-26"],
    ["experimental-node-24", "node-24"],
    ["experimental-node-26", "node-26"],
  ] as const)("normalizes %s before returning the resolved config", async (runtime, expected) => {
    const cwd = await createProject(runtime);

    await expect(loadConfig({ cwd, warn: false })).resolves.toMatchObject({ runtime: expected });
  });

  it("uses the current Node.js LTS when runtime is omitted", async () => {
    const cwd = await createProject();

    await expect(loadConfig({ cwd, warn: false })).resolves.toMatchObject({ runtime: "node-24" });
  });

  it.each(["node-23"])(
    "rejects unsupported public runtime %s while loading config",
    async (runtime) => {
      const cwd = await createProject(runtime);

      await expect(loadConfig({ cwd, warn: false })).rejects.toThrowError(
        new RegExp(`Unsupported runtime "${runtime}" in trigger\\.config`)
      );
    }
  );
});

describe("loadConfig bun runtime warnings", () => {
  async function outputWhileLoading(runtime: string) {
    const cwd = await createProject(runtime);
    const write = vi.spyOn(process.stdout, "write");
    try {
      await loadConfig({ cwd, warn: true });
      return write.mock.calls.map(([chunk]) => String(chunk)).join("");
    } finally {
      write.mockRestore();
    }
  }

  it.each(["bun", "bun-legacy"])(
    "warns that %s is deprecated and points at bun-1.4",
    async (runtime) => {
      const output = await outputWhileLoading(runtime);

      expect(output).toMatch(/deprecated/i);
      expect(output).toContain("bun-1.4");
    }
  );

  it("does not deprecate bun-1.4", async () => {
    expect(await outputWhileLoading("bun-1.4")).not.toMatch(/deprecated/i);
  });
});
