import {
  createMcpHandler,
  McpServer,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";

const SESSION = "mcps_3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6b";

const newServer = () =>
  new McpServer({ name: "t", version: "1.0.0" }, { capabilities: { tools: {} } });

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });

describe("Mcp-Session-Id on the stateless transports", () => {
  // Catches: the SDK starting to validate a client-sent session id on a stateless transport.
  it("legacy transport serves a request carrying the header", async () => {
    const server = newServer();
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    const response = await transport.handleRequest(
      post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { "Mcp-Session-Id": SESSION })
    );
    expect(response.status).toBe(200);
    await transport.close();
  });

  it("modern handler serves a request carrying the header", async () => {
    const modern = createMcpHandler(() => newServer(), { legacy: "reject", responseMode: "json" });
    const response = await modern.fetch(
      post(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": {},
              "io.modelcontextprotocol/clientInfo": { name: "t", version: "1" },
            },
          },
        },
        {
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": "tools/list",
          "Mcp-Session-Id": SESSION,
        }
      )
    );
    expect(response.status).toBe(200);
  });
});
