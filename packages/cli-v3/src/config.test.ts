import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
    ["experimental-node-24", "node-24"],
    ["experimental-node-26", "node-26"],
  ] as const)("normalizes %s before returning the resolved config", async (runtime, expected) => {
    const cwd = await createProject(runtime);

    await expect(loadConfig({ cwd, warn: false })).resolves.toMatchObject({ runtime: expected });
  });

  it("keeps node as the default", async () => {
    const cwd = await createProject();

    await expect(loadConfig({ cwd, warn: false })).resolves.toMatchObject({ runtime: "node" });
  });

  it.each(["node-24", "node-26", "node-23"])(
    "rejects unsupported public runtime %s while loading config",
    async (runtime) => {
      const cwd = await createProject(runtime);

      await expect(loadConfig({ cwd, warn: false })).rejects.toThrowError(
        new RegExp(`Unsupported runtime "${runtime}" in trigger\\.config`)
      );
    }
  );
});
