import { basePath } from "./base-path";

// WebMCP (https://webmachinelearning.github.io/webmcp/): lets an agent in the reader's browser
// search and read the docs. The spec puts the API on document.modelContext; earlier browser
// previews used navigator.modelContext. Feature-detected only: nothing loads where it's missing.
type WebMcpTool = {
  name: string;
  title?: string;
  description: string;
  inputSchema: object;
  annotations?: { readOnlyHint?: boolean };
  execute: (input: Record<string, unknown>) => Promise<string>;
};
type ModelContext = {
  registerTool: (tool: WebMcpTool, options?: { signal?: AbortSignal }) => unknown;
};

export function modelContext(): ModelContext | undefined {
  const holder = (globalThis.document ?? {}) as { modelContext?: ModelContext };
  const nav = (globalThis.navigator ?? {}) as { modelContext?: ModelContext };
  const mc = holder.modelContext ?? nav.modelContext;
  return typeof mc?.registerTool === "function" ? mc : undefined;
}

/** "tasks/overview", "/docs/tasks/overview#x" or a full docs URL, as the page's .md path. */
export function mdPath(input: string) {
  let path = input.trim();
  try {
    path = new URL(path, "https://trigger.dev/docs/").pathname;
  } catch {}
  path = path
    .replace(/[#?].*$/, "")
    .replace(/\.md$/, "")
    .replace(/\/$/, "");
  if (!path.startsWith("/")) path = `/${path}`;
  if (!path.startsWith(`${basePath}/`) && path !== basePath) path = `${basePath}${path}`;
  return `${path === basePath ? `${basePath}/introduction` : path}.md`;
}

type SearchHit = { url: string; type: string; content: string; breadcrumbs?: string[] };

export const webMcpTools: WebMcpTool[] = [
  {
    name: "search_docs",
    title: "Search the Trigger.dev docs",
    description:
      "Search the Trigger.dev documentation. Returns matching pages and sections with links. Use read_page to read a whole page.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "What to search for" } },
      required: ["query"],
    },
    annotations: { readOnlyHint: true },
    async execute({ query }) {
      if (typeof query !== "string" || !query.trim()) return "query is required";
      const res = await fetch(`${basePath}/api/search?query=${encodeURIComponent(query)}`);
      const hits = (await res.json()) as SearchHit[];
      if (!hits.length) return "No results.";
      return hits
        .map((h) =>
          h.type === "page"
            ? `\n# ${h.content}\n${location.origin}${basePath}${h.url}`
            : `- ${h.content} (${location.origin}${basePath}${h.url})`
        )
        .join("\n")
        .trim();
    },
  },
  {
    name: "read_page",
    title: "Read a Trigger.dev docs page",
    description:
      "Read one Trigger.dev docs page as markdown. Pass a path such as `tasks/overview` or a docs URL from search_docs.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Page path or docs URL" } },
      required: ["path"],
    },
    annotations: { readOnlyHint: true },
    async execute({ path }) {
      if (typeof path !== "string") return "path is required";
      const res = await fetch(mdPath(path));
      return res.ok ? res.text() : `No docs page at ${path}`;
    },
  },
];
