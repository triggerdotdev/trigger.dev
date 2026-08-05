// A JSON-RPC `tools/call` against the public docs MCP endpoint: no auth, no user data.
// The endpoint answers with either JSON or a single-event SSE stream.
const DOCS_MCP_URL = "https://trigger.dev/docs/mcp";
const DOCS_MCP_TOOL = "search_trigger_dev";
const DOCS_RESULT_MAX_CHARS = 20_000;

export async function searchTriggerDocs(
  query: string,
  signal: AbortSignal
): Promise<{ results: string } | { error: string }> {
  let res: Response;
  try {
    res = await fetch(DOCS_MCP_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-06-18",
      },
      signal,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: DOCS_MCP_TOOL, arguments: { query } },
      }),
    });
  } catch (error) {
    return { error: `Couldn't reach the docs: ${(error as Error).message}` };
  }

  if (!res.ok) return { error: `The docs search failed (status ${res.status}).` };

  const body = await res.text();
  let payload: any;
  if (res.headers.get("content-type")?.includes("text/event-stream")) {
    // One `data:` event carries the whole JSON-RPC response.
    const line = body.split("\n").find((l) => l.startsWith("data:"));
    if (!line) return { error: "The docs search returned no data." };
    try {
      payload = JSON.parse(line.slice(5).trim());
    } catch {
      return { error: "The docs search returned an unreadable response." };
    }
  } else {
    try {
      payload = JSON.parse(body);
    } catch {
      return { error: "The docs search returned an unreadable response." };
    }
  }

  if (payload?.error?.message) return { error: `The docs search failed: ${payload.error.message}` };

  const content = payload?.result?.content;
  const text = (Array.isArray(content) ? content : [])
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text as string)
    .join("\n\n")
    .trim();

  if (!text) return { error: "The docs search found nothing for that query." };
  return { results: text.slice(0, DOCS_RESULT_MAX_CHARS) };
}
