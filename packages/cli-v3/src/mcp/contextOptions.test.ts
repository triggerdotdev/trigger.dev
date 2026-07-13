import { describe, expect, it } from "vitest";
import { toMcpContextOptions } from "./contextOptions.js";
import type { McpCommandOptions } from "../commands/mcp.js";

// The dev-only guards only work if `--dev-only` is threaded from the parsed
// CLI options into the McpContext. These tests pin that wiring.
const baseOptions = {
  projectRef: "proj_123",
  apiUrl: "https://api.example.com",
  profile: "default",
  readonly: false,
  devOnly: false,
} as unknown as McpCommandOptions;

describe("toMcpContextOptions", () => {
  it("threads devOnly=true through to the context options", () => {
    expect(toMcpContextOptions({ ...baseOptions, devOnly: true }, undefined).devOnly).toBe(true);
  });

  it("threads devOnly=false through to the context options", () => {
    expect(toMcpContextOptions({ ...baseOptions, devOnly: false }, undefined).devOnly).toBe(false);
  });

  it("carries the other relevant options across", () => {
    const result = toMcpContextOptions(baseOptions, undefined);
    expect(result.projectRef).toBe("proj_123");
    expect(result.apiUrl).toBe("https://api.example.com");
    expect(result.profile).toBe("default");
    expect(result.readonly).toBe(false);
  });
});
