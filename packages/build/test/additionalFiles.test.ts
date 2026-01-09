import { describe, it, expect } from "vitest";
import { getGlobBase } from "../src/internal/additionalFiles.js";

describe("getGlobBase", () => {
  describe("glob patterns with wildcards", () => {
    it("extracts base from parent directory glob pattern", () => {
      expect(getGlobBase("../shared/**")).toBe("../shared");
    });

    it("extracts base from relative directory glob pattern", () => {
      expect(getGlobBase("./assets/*.txt")).toBe("./assets");
    });

    it("extracts base from nested directory glob pattern", () => {
      expect(getGlobBase("files/nested/**/*.js")).toBe("files/nested");
    });

    it("returns current directory for top-level glob", () => {
      expect(getGlobBase("**/*.js")).toBe(".");
    });

    it("returns current directory for star pattern", () => {
      expect(getGlobBase("*.js")).toBe(".");
    });

    it("handles question mark wildcard", () => {
      expect(getGlobBase("./src/?/*.ts")).toBe("./src");
    });

    it("handles bracket patterns", () => {
      expect(getGlobBase("./src/[abc]/*.ts")).toBe("./src");
    });

    it("handles brace expansion patterns", () => {
      expect(getGlobBase("./src/{a,b}/*.ts")).toBe("./src");
    });

    it("handles deeply nested patterns", () => {
      expect(getGlobBase("a/b/c/d/**")).toBe("a/b/c/d");
    });
  });

  describe("specific file paths without globs", () => {
    it("returns parent directory for file in subdirectory", () => {
      expect(getGlobBase("./config/settings.json")).toBe("./config");
    });

    it("returns parent directory for file in nested subdirectory", () => {
      expect(getGlobBase("../shared/utils/helpers.ts")).toBe("../shared/utils");
    });

    it("returns current directory for single-part filename", () => {
      expect(getGlobBase("file.txt")).toBe(".");
    });

    it("returns current directory for filename starting with dot", () => {
      expect(getGlobBase(".env")).toBe(".");
    });

    it("returns parent directory for explicit relative path to file", () => {
      expect(getGlobBase("./file.txt")).toBe(".");
    });

    it("returns parent directories for parent reference to file", () => {
      expect(getGlobBase("../file.txt")).toBe("..");
    });

    it("handles multiple parent references", () => {
      expect(getGlobBase("../../config/app.json")).toBe("../../config");
    });
  });

  describe("edge cases", () => {
    it("returns current directory for empty string", () => {
      expect(getGlobBase("")).toBe(".");
    });

    it("handles Windows-style backslashes", () => {
      expect(getGlobBase("..\\shared\\**")).toBe("../shared");
    });

    it("handles mixed forward and back slashes", () => {
      expect(getGlobBase("../shared\\nested/**")).toBe("../shared/nested");
    });

    it("handles patterns with only dots", () => {
      expect(getGlobBase("./")).toBe(".");
    });

    it("handles parent directory reference only", () => {
      expect(getGlobBase("../")).toBe("..");
    });
  });
});
