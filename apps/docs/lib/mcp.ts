import { pageMarkdown } from "./agent-markdown";
import { queryChoices } from "./choices";
import { searcher } from "./search";
import { excerpt } from "./search-core";
import { docsUrl, pageFromPath } from "./source";

// The docs MCP server's tools, also listed by its server card.
export const mcpTools = [
  {
    name: "search_trigger_dev",
    title: "Search documentation",
    description:
      "Search the Trigger.dev documentation for guides, API references and code examples. Returns matching sections with their page title and a direct link. Use get_page_trigger_dev to read a whole page.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Search query" } },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "get_page_trigger_dev",
    title: "Read a documentation page",
    description:
      "Read one Trigger.dev documentation page as markdown. Pass the path from a search result link, e.g. `tasks/overview` or `https://trigger.dev/docs/tasks/overview`. Add `?pm=pnpm` (npm, pnpm, yarn, bun) or `?framework=nextjs` to keep only that variant of tabbed code.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Page path or docs URL" } },
      required: ["path"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
];

// Stateless MCP server over Streamable HTTP (JSON responses). Published trigger.dev CLIs call
// `tools/call` for `search_trigger_dev` with no initialize handshake, so every request stands alone.

const PROTOCOL_VERSION = "2025-06-18";
const MAX_BATCH = 20;
const MAX_ARG = 500;

type Text = { type: "text"; text: string };

function search(query: string): Text[] {
  // Old CLIs hand these straight to a model: best page first, its best sections as the content.
  return searcher.search(query, { limit: 8 }).map(({ page, sections }) => {
    const best = sections.slice(0, 3);
    const link = best[0]?.id ? `${page.url}#${best[0].id}` : page.url;
    const content = [
      page.description,
      ...best.map((s) =>
        [s.heading && `## ${s.heading}`, excerpt(s.text, query, 600)].filter(Boolean).join("\n")
      ),
    ]
      .filter(Boolean)
      .join("\n\n");
    return {
      type: "text" as const,
      text: `Title: ${page.title}\nLink: ${docsUrl}${link}\nPage: ${page.url.slice(1)}\nContent: ${content}`,
    };
  });
}

async function getPage(input: string): Promise<Text[]> {
  const page = pageFromPath(input);
  if (!page) throw new RpcError(-32602, `No docs page at "${input}"`);
  // `?pm=pnpm` / `?framework=nextjs` on the URL keep only that variant of each tab group.
  const chosen = queryChoices(new URL(input, `${docsUrl}/`).searchParams);
  return [{ type: "text", text: await pageMarkdown(page, chosen) }];
}

// The previous docs host's MCP had a shell-like filesystem tool, and its search description told
// models to `head`/`cat` `<path>.mdx`. Not listed, but agents that learned it can still read a
// page that way; anything else gets pointed at the two real tools.
const LEGACY_FS_TOOL = "query_docs_filesystem_trigger_dev";
const legacyRead = /^\s*(?:cat|head|tail)\b(?:\s+-\S+(?:\s+\d+)?)*\s+(\/\S+?)(?:\.mdx?)?\s*$/;

function legacyFilesystemPath(command: string): string | undefined {
  return legacyRead.exec(command)?.[1];
}

async function legacyFilesystem(command: string) {
  const path = legacyFilesystemPath(command);
  if (path && pageFromPath(path)) return { content: await getPage(path) };
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: "This tool is retired. Use search_trigger_dev to search the docs and get_page_trigger_dev to read a page.",
      },
    ],
  };
}

class RpcError extends Error {
  constructor(
    public code: number,
    message: string
  ) {
    super(message);
  }
}

type Rpc = {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
};

async function handle(msg: Rpc): Promise<unknown> {
  switch (msg.method) {
    case "initialize":
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "trigger-dev-docs", version: "1.0.0" },
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: mcpTools };
    case "tools/call": {
      const name = msg.params?.name;
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      if (name === "search_trigger_dev") {
        if (typeof args.query !== "string" || !args.query.trim())
          throw new RpcError(-32602, "query is required");
        if (args.query.length > MAX_ARG)
          throw new RpcError(-32602, `query is longer than ${MAX_ARG} characters`);
        const content = search(args.query);
        return { content: content.length ? content : [{ type: "text", text: "No results." }] };
      }
      if (name === "get_page_trigger_dev") {
        if (typeof args.path !== "string") throw new RpcError(-32602, "path is required");
        if (args.path.length > MAX_ARG)
          throw new RpcError(-32602, `path is longer than ${MAX_ARG} characters`);
        return { content: await getPage(args.path) };
      }
      if (name === LEGACY_FS_TOOL) {
        if (typeof args.command !== "string") throw new RpcError(-32602, "command is required");
        if (args.command.length > MAX_ARG)
          throw new RpcError(-32602, `command is longer than ${MAX_ARG} characters`);
        return legacyFilesystem(args.command);
      }
      throw new RpcError(-32602, `Unknown tool: ${String(name)}`);
    }
    default:
      throw new RpcError(-32601, `Method not found: ${msg.method}`);
  }
}

async function respond(msg: Rpc) {
  try {
    return { jsonrpc: "2.0", id: msg.id ?? null, result: await handle(msg) };
  } catch (e) {
    const code = e instanceof RpcError ? e.code : -32603;
    // Bad input is the caller's problem; an exception in our code is ours. Arguments stay out.
    if (code === -32603)
      console.log(
        JSON.stringify({
          event: "mcp.error",
          method: msg.method,
          tool: msg.params?.name,
          error: String(e),
        })
      );
    // Exception text stays in the log: it can name files and internals.
    const message = code === -32603 ? "Internal error" : (e as Error).message;
    return { jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } };
  }
}

const invalidRequest = (message = "Invalid Request") => ({
  jsonrpc: "2.0",
  id: null,
  error: { code: -32600, message },
});

function isRpc(m: unknown): m is Rpc {
  return (
    typeof m === "object" &&
    m !== null &&
    !Array.isArray(m) &&
    (m as Rpc).jsonrpc === "2.0" &&
    typeof (m as Rpc).method === "string"
  );
}

/** Answers a parsed JSON-RPC message or batch for /mcp. */
export async function handleMcp(body: unknown) {
  const batch: unknown[] = Array.isArray(body) ? body : [body];
  if (batch.length === 0 || (!Array.isArray(body) && !isRpc(body)))
    return Response.json(invalidRequest(), { status: 400 });
  if (batch.length > MAX_BATCH)
    return Response.json(invalidRequest(`At most ${MAX_BATCH} messages per batch`), {
      status: 400,
    });
  // Notifications (no id) get no response body; a malformed batch member gets its own error.
  const replies = await Promise.all(
    batch
      .filter((m) => !isRpc(m) || m.id !== undefined)
      .map((m) => (isRpc(m) ? respond(m) : invalidRequest()))
  );
  if (replies.length === 0) return new Response(null, { status: 202 });
  return Response.json(Array.isArray(body) ? replies : replies[0]);
}
