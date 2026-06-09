import { afterAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveBundledPackageJSON } from "./skills.js";

/**
 * Reproduces the published layout: tshy emits a dialect stub `package.json`
 * ({"type":"module"}) in `dist/esm`, which shadows the real package root when resolving
 * from the bundled code. The skills dir ships at the package root. Resolution must skip
 * the stub and land on the root, otherwise `trigger skills` silently finds no skills.
 */
async function makeBundledPackage(): Promise<{ root: string; distEsm: string }> {
  const root = await mkdtemp(join(tmpdir(), "bundled-cli-"));

  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "trigger.dev", version: "9.9.9-test.1" })
  );

  await mkdir(join(root, "skills", "authoring-tasks"), { recursive: true });
  await writeFile(join(root, "skills", "authoring-tasks", "SKILL.md"), "# Authoring");

  const distEsm = join(root, "dist", "esm");
  await mkdir(distEsm, { recursive: true });
  // The tshy dialect stub that caused the bug.
  await writeFile(join(distEsm, "package.json"), JSON.stringify({ type: "module" }));

  return { root, distEsm };
}

describe("resolveBundledPackageJSON", () => {
  const roots: string[] = [];

  afterAll(async () => {
    await Promise.all(roots.map((d) => rm(d, { recursive: true, force: true })));
  });

  it("skips the tshy dist/esm dialect stub and resolves the package root", async () => {
    const { root, distEsm } = await makeBundledPackage();
    roots.push(root);

    const resolved = await resolveBundledPackageJSON(distEsm);

    // Must be the root package.json (which has `skills/` beside it), not the dist/esm stub.
    expect(resolved).toBe(join(root, "package.json"));
    expect(dirname(resolved!)).toBe(root);
  });

  it("resolves directly when started from a dir under the named package root (source/tsx path)", async () => {
    const { root } = await makeBundledPackage();
    roots.push(root);

    const srcDir = join(root, "src");
    await mkdir(srcDir, { recursive: true });

    const resolved = await resolveBundledPackageJSON(srcDir);

    expect(resolved).toBe(join(root, "package.json"));
  });
});
