import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { resolveDevEnvVars } from "./localEnvVars.js";
import { buildDevRunEnv } from "./sanitizeEnvVars.js";

test("server empties survive startup and subsequent runs without stale worker overrides", () => {
  const directory = mkdtempSync(join(tmpdir(), "trigger-dev-env-"));
  try {
    const envFile = join(directory, ".env");
    writeFileSync(envFile, 'TEST_FILE_OVERRIDE="local"\nTEST_LOCAL_EMPTY=\n');
    const worker = resolveDevEnvVars({
      envFile,
      projectEnv: {
        TEST_EMPTY: "",
        TEST_UPDATED: "old",
        TEST_REMOVED: "old",
        TEST_FILE_OVERRIDE: "server",
        TEST_LOCAL_EMPTY: "server",
      },
      overrides: { NODE_ENV: "development" },
      projectRef: "proj_123",
    });

    // Indexing imports modules before any per-run IPC environment update.
    const startup = spawnSync(
      process.execPath,
      ["-e", 'require("node:assert/strict").equal(process.env.TEST_EMPTY, "");'],
      { env: worker.env, encoding: "utf8" }
    );
    expect(startup.stderr).toBe("");
    expect(startup.status).toBe(0);

    const runEnv = buildDevRunEnv({
      resolvedEnvVars: {
        TEST_EMPTY: "",
        TEST_UPDATED: "",
        TEST_FILE_OVERRIDE: "fresh-server",
        TEST_LOCAL_EMPTY: "server",
      },
      processEnv: worker.processEnv,
      envOverrides: worker.envOverrides,
      projectRef: "proj_123",
    });
    const run = spawnSync(
      process.execPath,
      [
        "-e",
        'console.log(JSON.stringify({value:process.env.TEST_UPDATED, present:Object.hasOwn(process.env,"TEST_UPDATED")}))',
      ],
      { env: runEnv, encoding: "utf8" }
    );
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ value: "", present: true });
    expect(runEnv.TEST_REMOVED).toBeUndefined();
    expect(runEnv.TEST_FILE_OVERRIDE).toBe("local");
    expect(runEnv.TEST_LOCAL_EMPTY).toBe("server");
    expect(runEnv.NODE_ENV).toBe("development");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
