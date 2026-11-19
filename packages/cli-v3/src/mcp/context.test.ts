import { describe, expect, it } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { pathToFileURL } from "node:url";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { McpContext } from "./context.js";

function createFakeServer(rootUri?: string) {
  return {
    server: {
      getClientCapabilities: () => ({ roots: {} }),
      listRoots: async () => ({
        roots: rootUri ? [{ uri: rootUri }] : [],
      }),
    },
  } as unknown as McpServer;
}

describe("McpContext.getProjectRef", () => {
  it("uses the server option projectRef when no per-call projectRef or config is present", async () => {
    const fakeServer = createFakeServer();
    const ctx = new McpContext(fakeServer, {
      projectRef: "proj_from_cli_flag",
    });

    const ref = await ctx.getProjectRef({});
    expect(ref).toBe("proj_from_cli_flag");
  });

  it("prefers per-call projectRef over server option projectRef", async () => {
    const fakeServer = createFakeServer();
    const ctx = new McpContext(fakeServer, {
      projectRef: "proj_from_cli_flag",
    });

    const ref = await ctx.getProjectRef({ projectRef: "proj_from_tool_call" });
    expect(ref).toBe("proj_from_tool_call");
  });

  it("throws when neither per-call nor server option is set and no trigger.config.ts is found", async () => {
    // Create an empty temp directory without any trigger.config.ts
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trigger-mcp-test-"));
    try {
      const fakeServer = createFakeServer(pathToFileURL(tempDir).href);
      const ctx = new McpContext(fakeServer, {});

      await expect(ctx.getProjectRef({})).rejects.toThrow(/No project ref found/);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("throws with roots capability error when client has no roots capability and no cwd is passed", async () => {
    const serverWithoutRoots = {
      server: {
        getClientCapabilities: () => undefined,
      },
    } as unknown as McpServer;

    const ctx = new McpContext(serverWithoutRoots, {});

    await expect(ctx.getProjectRef({})).rejects.toThrow(
      /The current MCP server does not support the roots capability/
    );
  });
});
