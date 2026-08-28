import { sliceWellFormed } from "@internal/dashboard-agent-contracts";

// A JSON-RPC `tools/call` against the public docs MCP endpoint: no auth, no user data.
// The endpoint answers with either JSON or a single-event SSE stream.
const DOCS_MCP_URL = "https://trigger.dev/docs/mcp";
const DOCS_MCP_TOOL = "search_trigger_dev";

/**
 * What a docs answer may cost. The endpoint returns whole page sections, several of
 * them, and they then sit in the history for the rest of the conversation — one
 * question used to be worth thousands of tokens on every later turn.
 *
 * A handful of excerpts is what the model actually needs: enough to quote, plus the
 * link to send the user to (or to read in full via ask_support).
 */
const MAX_DOC_RESULTS = 5;
const DOC_EXCERPT_MAX_CHARS = 1_200;
export const DOCS_RESULT_MAX_CHARS = 7_000;

/** An `<img …>` in the source is a kilobyte of srcset and nothing the model can use. */
function stripDocNoise(content: string): string {
  return content
    .replace(/<img\b[^>]*>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function field(part: string, name: string): string | undefined {
  const match = part.match(new RegExp(`^${name}:\\s*(.*)$`, "m"));
  return match?.[1]?.trim() || undefined;
}

/**
 * One result per content part: `Title` / `Link` / `Page` / `Content`, as the endpoint
 * writes them. A part in some other shape is kept as a bare excerpt rather than
 * dropped — a docs answer we can't parse is still an answer.
 */
export function formatDocsResults(parts: string[]): string {
  const rendered: string[] = [];
  let used = 0;

  for (const part of parts.slice(0, MAX_DOC_RESULTS)) {
    const contentAt = part.search(/^Content:/m);
    const body = stripDocNoise(contentAt === -1 ? part : part.slice(contentAt + "Content:".length));
    if (!body) continue;

    const excerpt =
      body.length > DOC_EXCERPT_MAX_CHARS
        ? `${sliceWellFormed(body, DOC_EXCERPT_MAX_CHARS).trimEnd()}… [excerpt — the rest is on the page]`
        : body;

    const entry = [
      field(part, "Title") ? `Title: ${field(part, "Title")}` : undefined,
      field(part, "Page") ? `Page: ${field(part, "Page")}` : undefined,
      field(part, "Link") ? `Link: ${field(part, "Link")}` : undefined,
      excerpt,
    ]
      .filter(Boolean)
      .join("\n");

    // Stop on the overall cap rather than truncating mid-excerpt: a half-quoted
    // sentence is worse than one fewer result.
    if (used + entry.length > DOCS_RESULT_MAX_CHARS) break;
    rendered.push(entry);
    used += entry.length;
  }

  return rendered.join("\n\n---\n\n");
}

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
  const parts = (Array.isArray(content) ? content : [])
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => (part.text as string).trim())
    .filter(Boolean);

  const text = formatDocsResults(parts);
  if (!text) return { error: "The docs search found nothing for that query." };
  return { results: text };
}
