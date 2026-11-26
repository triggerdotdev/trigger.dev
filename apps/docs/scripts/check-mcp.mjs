#!/usr/bin/env node
// MCP shape at <base>/mcp. Search sends the exact request published trigger.dev CLIs send
// (packages/cli-v3/src/mcp/mintlifyClient.ts): tools/call with no initialize handshake, and the
// CLI hands result.content straight to the model, so it must be text content with /docs/ links.
// get_page must return a page with its snippets inlined (the page body comes from the build).
// Usage: node scripts/check-mcp.mjs <base, e.g. http://localhost:43000/docs>
const [base] = process.argv.slice(2);
if (!base) {
  console.error("usage: node scripts/check-mcp.mjs <base>");
  process.exit(2);
}

// A preview behind Vercel Authentication lets the check in with the project's automation bypass secret.
const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
const bypassHeaders = bypass ? { "x-vercel-protection-bypass": bypass } : {};

async function call(name, args) {
  const res = await fetch(`${base.replace(/\/$/, "")}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
      ...bypassHeaders,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const text = await res.text();
  const json = res.headers.get("content-type")?.includes("text/event-stream")
    ? JSON.parse(
        text
          .split("\n")
          .find((l) => l.startsWith("data:"))
          ?.slice(5)
          .trim() ?? "null"
      )
    : JSON.parse(text);
  return {
    status: res.status,
    items: (json?.result?.content ?? []).filter((c) => c.type === "text" && c.text?.length),
  };
}

const failures = [];
const search = await call("search_trigger_dev", { query: "how do I retry a task" });
if (search.status !== 200 || !search.items.some((c) => /\/docs\//.test(c.text)))
  failures.push(
    `search_trigger_dev: status ${search.status}, ${search.items.length} text results, none with a /docs/ link`
  );

// cli-dev-commands is mostly one snippet; inlined, its <CliDevCommands /> tag is gone.
const page = await call("get_page_trigger_dev", { path: "/cli-dev-commands" });
const md = page.items[0]?.text ?? "";
if (
  page.status !== 200 ||
  !md.startsWith("# ") ||
  md.includes("<CliDevCommands") ||
  md.length < 1000
)
  failures.push(`get_page_trigger_dev: status ${page.status}, ${md.length} chars`);

// The previous host's filesystem tool: agents that learned `head <path>.mdx` still get the page.
const legacy = await call("query_docs_filesystem_trigger_dev", {
  command: "head -200 /cli-dev-commands.mdx",
});
if (legacy.status !== 200 || !legacy.items[0]?.text.startsWith("# "))
  failures.push(`query_docs_filesystem_trigger_dev: status ${legacy.status}, no page`);

// Bad requests: invalid bodies, empty and oversized batches get -32600 with a 400; a malformed
// batch member gets its own -32600; an oversized query is refused.
async function raw(body) {
  const res = await fetch(`${base.replace(/\/$/, "")}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", ...bypassHeaders },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const toolCall = (id, args) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name: "search_trigger_dev", arguments: args },
});
const bad = [
  ["number body", 5, (r) => r.status === 400 && r.json?.error?.code === -32600],
  ["null body", null, (r) => r.status === 400 && r.json?.error?.code === -32600],
  ["empty batch", [], (r) => r.status === 400 && r.json?.error?.code === -32600],
  [
    "21-message batch",
    Array.from({ length: 21 }, (_, i) => toolCall(i, { query: "retry" })),
    (r) => r.status === 400 && r.json?.error?.code === -32600,
  ],
  ["malformed member", [5], (r) => r.status === 200 && r.json?.[0]?.error?.code === -32600],
  [
    "501-char query",
    toolCall(1, { query: "a".repeat(501) }),
    (r) => r.status === 200 && r.json?.error?.code === -32602,
  ],
];
for (const [name, body, ok] of bad) {
  const r = await raw(body);
  if (!ok(r))
    failures.push(`${name}: status ${r.status}, ${JSON.stringify(r.json)?.slice(0, 200)}`);
}

console.log(`mcp: search ${search.items.length} results, get_page ${md.length} chars`);
for (const f of failures) console.log(`FAIL ${f}`);
console.log(failures.length ? "mcp: failed" : "mcp: passed");
process.exitCode = failures.length ? 1 : 0;
