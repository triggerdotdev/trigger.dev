import { build } from "esbuild";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterAll, expect, test } from "vitest";

const packageDir = fileURLToPath(new URL("../", import.meta.url));
const tempDir = mkdtempSync(join(tmpdir(), "redis-worker-build-output-"));

const require = createRequire(import.meta.url);

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

test("the ESM output can be rebundled and loaded as CommonJS", async () => {
  const buildResult = spawnSync("pnpm", ["exec", "tsdown"], {
    cwd: packageDir,
    encoding: "utf8",
  });
  const buildOutput = [buildResult.stdout, buildResult.stderr].filter(Boolean).join("\n");

  expect(buildResult.error, buildOutput).toBeUndefined();
  expect(buildResult.status, buildOutput).toBe(0);

  const esmPath = join(packageDir, "dist/index.js");
  const esmOutput = readFileSync(esmPath, "utf8");
  expect(esmOutput).not.toMatch(/\b[\w$]*createRequire[\w$]*\s*\(\s*import\.meta\.url\s*\)/);

  const cjsPath = join(tempDir, "index.cjs");
  await build({
    entryPoints: [esmPath],
    outfile: cjsPath,
    bundle: true,
    format: "cjs",
    platform: "node",
    logLevel: "silent",
  });

  expect(() => require(cjsPath)).not.toThrow();
}, 30_000);
