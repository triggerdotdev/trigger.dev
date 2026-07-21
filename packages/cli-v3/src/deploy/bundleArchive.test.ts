import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tar from "tar";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBundleArchive } from "./bundleArchive.js";

describe("createBundleArchive", () => {
  let bundleDir: string;
  let outDir: string;

  beforeEach(async () => {
    bundleDir = await mkdtemp(join(tmpdir(), "bundle-src-"));
    outDir = await mkdtemp(join(tmpdir(), "bundle-out-"));
  });

  afterEach(async () => {
    await rm(bundleDir, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
  });

  it("archives bundle contents at the root, including dotfiles and nested dirs", async () => {
    // Shape of a real buildWorker output dir
    await writeFile(join(bundleDir, "build.json"), JSON.stringify({ contentHash: "abc" }));
    await writeFile(join(bundleDir, "Containerfile"), "FROM scratch");
    await writeFile(join(bundleDir, "package.json"), "{}");
    await writeFile(join(bundleDir, "index.mjs"), "export {}");
    await writeFile(join(bundleDir, ".dockerignore"), "trigger-build-args.json\n");
    await writeFile(join(bundleDir, "trigger-build-args.json"), JSON.stringify({ env: {} }));
    await mkdir(join(bundleDir, ".trigger", "skills", "my-skill"), { recursive: true });
    await writeFile(join(bundleDir, ".trigger", "skills", "my-skill", "SKILL.md"), "# skill");

    const archivePath = join(outDir, "bundle.tar.gz");
    await createBundleArchive(bundleDir, archivePath);

    const extractDir = join(outDir, "extracted");
    await mkdir(extractDir);
    // The build server extracts WITHOUT stripping path components — the contract
    // is that bundle contents live at the archive root.
    await tar.extract({ file: archivePath, cwd: extractDir });

    const rootEntries = (await readdir(extractDir)).sort();
    expect(rootEntries).toEqual(
      [
        ".dockerignore",
        ".trigger",
        "Containerfile",
        "build.json",
        "index.mjs",
        "package.json",
        "trigger-build-args.json",
      ].sort()
    );

    // Nested dot-dir contents survive
    const skill = await readFile(
      join(extractDir, ".trigger", "skills", "my-skill", "SKILL.md"),
      "utf-8"
    );
    expect(skill).toBe("# skill");
  });

  it("excludes node_modules and .DS_Store but nothing else", async () => {
    await writeFile(join(bundleDir, "build.json"), "{}");
    await writeFile(join(bundleDir, ".DS_Store"), "junk");
    await mkdir(join(bundleDir, "node_modules", "leftover"), { recursive: true });
    await writeFile(join(bundleDir, "node_modules", "leftover", "index.js"), "x");
    // dist-like names must NOT be excluded — the bundle IS build output
    await mkdir(join(bundleDir, "dist"), { recursive: true });
    await writeFile(join(bundleDir, "dist", "chunk.mjs"), "x");

    const archivePath = join(outDir, "bundle.tar.gz");
    await createBundleArchive(bundleDir, archivePath);

    const extractDir = join(outDir, "extracted");
    await mkdir(extractDir);
    await tar.extract({ file: archivePath, cwd: extractDir });

    const rootEntries = (await readdir(extractDir)).sort();
    expect(rootEntries).toEqual(["build.json", "dist"].sort());
  });

  it("throws when the bundle dir is empty", async () => {
    await expect(createBundleArchive(bundleDir, join(outDir, "bundle.tar.gz"))).rejects.toThrow(
      /No files found/
    );
  });
});
