import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { McpContext } from "./context.js";

vi.mock("@trigger.dev/core/utils", () => ({
  tryCatch: async <T>(p: Promise<T>): Promise<[Error | null, T | null]> => {
    try {
      return [null, await p];
    } catch (e) {
      return [e as Error, null];
    }
  },
}));

vi.mock("@trigger.dev/core/v3", () => ({
  ApiClient: class {},
}));

vi.mock("../apiClient.js", () => ({
  CliApiClient: class {},
}));

vi.mock("../config.js", () => ({
  loadConfig: async () => ({}),
}));

vi.mock("./auth.js", () => ({
  mcpAuth: async () => ({ ok: true, auth: { apiUrl: "", accessToken: "" } }),
}));

const server = () => new McpServer({ name: "trigger.dev", version: "test" });

describe("McpContext.getProjectRef", () => {
  it("prefers the projectRef passed on the tool call", async () => {
    const ctx = new McpContext(server(), { projectRef: "proj_flag" });
    await expect(ctx.getProjectRef({ projectRef: "proj_call" })).resolves.toBe("proj_call");
  });

  it("falls back to the --project-ref option when the call omits one", async () => {
    const ctx = new McpContext(server(), { projectRef: "proj_flag" });
    await expect(ctx.getProjectRef({})).resolves.toBe("proj_flag");
  });

  it("still errors when no projectRef is provided anywhere", async () => {
    const ctx = new McpContext(server(), {});
    await expect(ctx.getProjectRef({})).rejects.toThrow();
  });
});
