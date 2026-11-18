import { z } from "zod";
import { fenceUntrusted } from "../gate/fence.server";
import type { McpToolDefinition } from "../registry.server";
import type { McpToolResult } from "../gate/withMcpToolAuth.server";
import { defineReadTool, errorResult } from "./define.server";

const DOCS_MCP_URL = "https://trigger.dev/docs/mcp";
const MAX_RESULT_CHARS = 20_000;
const TIMEOUT_MS = 10_000;

type Fetcher = typeof fetch;

async function readFirstSseData(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("No reader found");
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) throw new Error("SSE stream closed before data arrived");
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n?/g, "\n");
      const events = buffer.split("\n\n");
      buffer = events.pop()!;
      for (const event of events) {
        for (const line of event.split("\n")) {
          if (line.startsWith("data:")) return JSON.parse(line.slice(5).trim());
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function boundResult(result: McpToolResult): McpToolResult {
  let remaining = MAX_RESULT_CHARS;
  const content = result.content.map((part) => {
    if (part.type !== "text") return part;
    const overhead = fenceUntrusted("", "docs").length;
    const fenced = fenceUntrusted(part.text.slice(0, Math.max(remaining - overhead, 0)), "docs");
    remaining -= fenced.length;
    return { ...part, text: fenced };
  });
  return { ...result, content };
}

export function createDocsTools({
  fetcher = fetch,
}: { fetcher?: Fetcher } = {}): McpToolDefinition[] {
  return [
    defineReadTool({
      name: "search_docs",
      title: "Search Docs",
      description:
        "Search across the Trigger.dev documentation to find relevant information, code examples, API references, and guides. Use this tool when you need to answer questions about Trigger.dev, find specific documentation, understand how features work, or locate implementation details. The search returns contextual content with titles and direct links to the documentation pages",
      shape: { query: z.string() },
      auth: { public: true },
      run: async (input) => {
        const response = await fetcher(DOCS_MCP_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            "MCP-Protocol-Version": "2025-06-18",
          },
          signal: AbortSignal.timeout(TIMEOUT_MS),
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "search_trigger_dev", arguments: { query: input.query } },
          }),
        });

        const data = (
          response.headers.get("content-type")?.includes("text/event-stream")
            ? await readFirstSseData(response)
            : await response.json()
        ) as { result?: McpToolResult };

        if (!data.result?.content) return errorResult("Docs search returned no result");
        return boundResult({ content: data.result.content, isError: data.result.isError });
      },
    }),
  ];
}

export const docsTools = createDocsTools();
