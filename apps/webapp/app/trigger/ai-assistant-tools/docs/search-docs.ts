import { tool } from "ai";
import { searchDocs as searchDocsSchema } from "~/lib/ai-assistant/tool-schemas";

const MINTLIFY_MCP_URL = "https://trigger.dev/docs/mcp";
const MCP_PROTOCOL_VERSION = "2025-06-18";

export function createSearchDocsTool() {
  return tool({
    ...searchDocsSchema,
    execute: async ({ query }) => {
      try {
        const body = {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "search_trigger_dev", arguments: { query } },
        };

        const response = await fetch(MINTLIFY_MCP_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
          },
          body: JSON.stringify(body),
        });

        const data: any = await parseResponse(response);
        return { success: true, results: data?.result ?? data };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });
}

// --- Mintlify response parsing (handles both SSE and JSON) ---
// Adapted from packages/cli-v3/src/mcp/mintlifyClient.ts

async function parseResponse(response: Response) {
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    return parseSSEResponse(response);
  }
  return response.json();
}

async function parseSSEResponse(response: Response) {
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  if (!reader) throw new Error("No reader found");

  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) throw new Error("SSE stream closed before data arrived");
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop()!;
    for (const evt of events) {
      for (const line of evt.split("\n")) {
        if (line.startsWith("data:")) {
          return JSON.parse(line.slice(5).trim());
        }
      }
    }
  }
}