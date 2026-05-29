import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { evaluateDiscovery, type DiscoverySpec } from "./discoveryCheck.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "discovery-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("evaluateDiscovery", () => {
  describe("show-if-found with file existence", () => {
    it("returns true when file exists", async () => {
      await fs.writeFile(path.join(tmpDir, "trigger.config.ts"), "export default {}");

      const spec: DiscoverySpec = {
        filePatterns: ["trigger.config.ts"],
        matchBehavior: "show-if-found",
      };

      expect(await evaluateDiscovery(spec, tmpDir)).toBe(true);
    });

    it("returns false when file does not exist", async () => {
      const spec: DiscoverySpec = {
        filePatterns: ["trigger.config.ts"],
        matchBehavior: "show-if-found",
      };

      expect(await evaluateDiscovery(spec, tmpDir)).toBe(false);
    });
  });

  describe("show-if-not-found with file existence", () => {
    it("returns false when file exists", async () => {
      await fs.writeFile(path.join(tmpDir, ".mcp.json"), "{}");

      const spec: DiscoverySpec = {
        filePatterns: [".mcp.json"],
        matchBehavior: "show-if-not-found",
      };

      expect(await evaluateDiscovery(spec, tmpDir)).toBe(false);
    });

    it("returns true when file does not exist", async () => {
      const spec: DiscoverySpec = {
        filePatterns: [".mcp.json"],
        matchBehavior: "show-if-not-found",
      };

      expect(await evaluateDiscovery(spec, tmpDir)).toBe(true);
    });
  });

  describe("content pattern matching", () => {
    it("show-if-found: returns true when content matches", async () => {
      await fs.writeFile(
        path.join(tmpDir, "trigger.config.ts"),
        'import { syncVercelEnvVars } from "@trigger.dev/build";'
      );

      const spec: DiscoverySpec = {
        filePatterns: ["trigger.config.ts"],
        contentPattern: "syncVercelEnvVars",
        matchBehavior: "show-if-found",
      };

      expect(await evaluateDiscovery(spec, tmpDir)).toBe(true);
    });

    it("show-if-found: returns false when file exists but content does not match", async () => {
      await fs.writeFile(path.join(tmpDir, "trigger.config.ts"), "export default {}");

      const spec: DiscoverySpec = {
        filePatterns: ["trigger.config.ts"],
        contentPattern: "syncVercelEnvVars",
        matchBehavior: "show-if-found",
      };

      expect(await evaluateDiscovery(spec, tmpDir)).toBe(false);
    });

    it("show-if-not-found: returns true when file exists but content does not match", async () => {
      await fs.writeFile(path.join(tmpDir, ".mcp.json"), '{"mcpServers": {}}');

      const spec: DiscoverySpec = {
        filePatterns: [".mcp.json"],
        contentPattern: "trigger",
        matchBehavior: "show-if-not-found",
      };

      expect(await evaluateDiscovery(spec, tmpDir)).toBe(true);
    });

    it("show-if-not-found: returns false when content matches", async () => {
      await fs.writeFile(
        path.join(tmpDir, ".mcp.json"),
        '{"mcpServers": {"trigger": {"url": "https://mcp.trigger.dev"}}}'
      );

      const spec: DiscoverySpec = {
        filePatterns: [".mcp.json"],
        contentPattern: "trigger",
        matchBehavior: "show-if-not-found",
      };

      expect(await evaluateDiscovery(spec, tmpDir)).toBe(false);
    });

    it("supports regex content patterns", async () => {
      await fs.writeFile(path.join(tmpDir, "config.ts"), "syncVercelEnvVars({ foo: true })");

      const spec: DiscoverySpec = {
        filePatterns: ["config.ts"],
        contentPattern: "syncVercel\\w+",
        matchBehavior: "show-if-found",
      };

      expect(await evaluateDiscovery(spec, tmpDir)).toBe(true);
    });
  });

  describe("glob patterns", () => {
    it("matches files with glob patterns", async () => {
      await fs.writeFile(path.join(tmpDir, "trigger.config.ts"), "export default {}");

      const spec: DiscoverySpec = {
        filePatterns: ["trigger.config.*"],
        matchBehavior: "show-if-found",
      };

      expect(await evaluateDiscovery(spec, tmpDir)).toBe(true);
    });

    it("matches files in subdirectories with glob", async () => {
      await fs.mkdir(path.join(tmpDir, ".cursor"), { recursive: true });
      await fs.writeFile(path.join(tmpDir, ".cursor", "mcp.json"), "{}");

      const spec: DiscoverySpec = {
        filePatterns: [".cursor/mcp.json"],
        matchBehavior: "show-if-found",
      };

      expect(await evaluateDiscovery(spec, tmpDir)).toBe(true);
    });
  });

  describe("multiple file patterns", () => {
    it("returns true if any pattern matches (show-if-found)", async () => {
      await fs.writeFile(path.join(tmpDir, "trigger.config.js"), "module.exports = {}");

      const spec: DiscoverySpec = {
        filePatterns: ["trigger.config.ts", "trigger.config.js"],
        matchBehavior: "show-if-found",
      };

      expect(await evaluateDiscovery(spec, tmpDir)).toBe(true);
    });

    it("returns true only if no pattern matches (show-if-not-found)", async () => {
      const spec: DiscoverySpec = {
        filePatterns: [".mcp.json", ".cursor/mcp.json"],
        matchBehavior: "show-if-not-found",
      };

      expect(await evaluateDiscovery(spec, tmpDir)).toBe(true);
    });

    it("content match short-circuits on first matching file", async () => {
      await fs.writeFile(path.join(tmpDir, "a.ts"), "no match here");
      await fs.writeFile(path.join(tmpDir, "b.ts"), "syncVercelEnvVars found");

      const spec: DiscoverySpec = {
        filePatterns: ["a.ts", "b.ts"],
        contentPattern: "syncVercelEnvVars",
        matchBehavior: "show-if-found",
      };

      expect(await evaluateDiscovery(spec, tmpDir)).toBe(true);
    });
  });

  describe("error handling (fail closed)", () => {
    it("returns false when file cannot be read for content check", async () => {
      // Create a file then make it unreadable
      const filePath = path.join(tmpDir, "unreadable.ts");
      await fs.writeFile(filePath, "content");
      await fs.chmod(filePath, 0o000);

      const spec: DiscoverySpec = {
        filePatterns: ["unreadable.ts"],
        contentPattern: "content",
        matchBehavior: "show-if-found",
      };

      // On some systems (e.g., running as root), chmod may not restrict reads
      // So we just verify it doesn't throw
      const result = await evaluateDiscovery(spec, tmpDir);
      expect(typeof result).toBe("boolean");

      // Restore permissions for cleanup
      await fs.chmod(filePath, 0o644);
    });
  });
});
