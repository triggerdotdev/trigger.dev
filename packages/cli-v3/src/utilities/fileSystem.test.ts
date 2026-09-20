import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFile, createFileWithStore, sanitizeHashForFilename } from "./fileSystem.js";

describe("fileSystem", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "trigger-fs-test-"));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe("sanitizeHashForFilename", () => {
    it("replaces forward slashes with underscores and pluses with hyphens", () => {
      expect(sanitizeHashForFilename("abc/def+ghi")).toBe("abc_def-ghi");
      expect(sanitizeHashForFilename("a/b/c+d+e")).toBe("a_b_c-d-e");
      expect(sanitizeHashForFilename("clean-hash_123")).toBe("clean-hash_123");
    });
  });

  describe("createFileWithStore", () => {
    it("succeeds when storeDir does not exist yet", async () => {
      const storeDir = join(testDir, "store");
      const buildDir = join(testDir, "build");
      const filePath = join(buildDir, "index.js");
      const content = "console.log('hello world');";
      const hash = "hash123/abc+def";

      expect(existsSync(storeDir)).toBe(false);

      const result = await createFileWithStore(filePath, content, storeDir, hash);

      expect(result).toBe(filePath);
      expect(existsSync(storeDir)).toBe(true);
      expect(existsSync(filePath)).toBe(true);
      expect(await readFile(filePath, "utf8")).toBe(content);

      const storeFile = join(storeDir, sanitizeHashForFilename(hash));
      expect(existsSync(storeFile)).toBe(true);
      expect(await readFile(storeFile, "utf8")).toBe(content);
    });

    it("uses content-addressable caching when storeDir and file already exist", async () => {
      const storeDir = join(testDir, "store");
      const buildDir = join(testDir, "build");
      const filePath1 = join(buildDir, "first.js");
      const filePath2 = join(buildDir, "second.js");
      const content = "export const answer = 42;";
      const hash = "shared-hash-xyz";

      // First run: writes to store and destination
      await createFileWithStore(filePath1, content, storeDir, hash);
      expect(existsSync(filePath1)).toBe(true);

      const storeFile = join(storeDir, sanitizeHashForFilename(hash));
      const storeStatBefore = await stat(storeFile);

      // Second run: re-running with existing store uses cached storePath (hardlink or copy)
      await createFileWithStore(filePath2, content, storeDir, hash);
      expect(existsSync(filePath2)).toBe(true);
      expect(await readFile(filePath2, "utf8")).toBe(content);

      const storeStatAfter = await stat(storeFile);
      // Store file modified time should not have been updated because it was not rewritten
      expect(storeStatAfter.mtimeMs).toBe(storeStatBefore.mtimeMs);
    });

    it("replaces existing file at destination path if already present", async () => {
      const storeDir = join(testDir, "store");
      const buildDir = join(testDir, "build");
      const filePath = join(buildDir, "output.js");
      const oldContent = "old content";
      const newContent = "new content";

      // Write initial file at destination
      await createFile(filePath, oldContent);
      expect(await readFile(filePath, "utf8")).toBe(oldContent);

      // Now create with store replacing it
      await createFileWithStore(filePath, newContent, storeDir, "new-hash");

      expect(await readFile(filePath, "utf8")).toBe(newContent);
    });

    it("handles deeply nested non-existent store and build paths", async () => {
      const storeDir = join(testDir, "deeply", "nested", "custom", "store");
      const buildDir = join(testDir, "another", "nested", "out");
      const filePath = join(buildDir, "chunk.js");
      const content = "export default 1;";
      const hash = "deep/hash+test";

      expect(existsSync(storeDir)).toBe(false);
      expect(existsSync(buildDir)).toBe(false);

      await createFileWithStore(filePath, content, storeDir, hash);

      expect(existsSync(filePath)).toBe(true);
      expect(existsSync(storeDir)).toBe(true);
      expect(await readFile(filePath, "utf8")).toBe(content);
    });
  });
});
