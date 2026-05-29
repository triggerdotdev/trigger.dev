/**
 * Smoke test for MCP tools against a running webapp.
 *
 * Usage:
 *   npx tsx src/mcp/smoke.test.ts [--api-url URL] [--project-ref REF]
 *
 * Requires:
 *   - Webapp running (default http://localhost:3030)
 *   - Valid CLI auth profile
 *
 * Tests all read-only tools and verifies they return non-error responses.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

type TestResult = {
  tool: string;
  status: "pass" | "fail" | "skip";
  duration: number;
  error?: string;
  preview?: string;
};

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {}
): Promise<{ isError: boolean; text: string }> {
  const result = await client.callTool({ name, arguments: args });

  const text = (result.content as Array<{ type: string; text?: string }>)
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text!)
    .join("\n");

  return { isError: !!result.isError, text };
}

function preview(text: string, maxLen = 80): string {
  const first = text.split("\n")[0] ?? "";
  return first.length > maxLen ? first.slice(0, maxLen) + "..." : first;
}

async function main() {
  const args = process.argv.slice(2);

  let apiUrl = "http://localhost:3030";
  const apiUrlIdx = args.indexOf("--api-url");
  if (apiUrlIdx !== -1) {
    apiUrl = args[apiUrlIdx + 1] ?? apiUrl;
    args.splice(apiUrlIdx, 2);
  }

  let projectRef = "proj_rrkpdguyagvsoktglnod";
  const projIdx = args.indexOf("--project-ref");
  if (projIdx !== -1) {
    projectRef = args[projIdx + 1] ?? projectRef;
    args.splice(projIdx, 2);
  }

  const env = "dev";
  const commonArgs = { projectRef, environment: env };

  const cliPath = path.resolve(__dirname, "..", "..", "dist", "esm", "index.js");

  const transport = new StdioClientTransport({
    command: "node",
    args: [cliPath, "mcp", "--api-url", apiUrl],
    stderr: "pipe",
  });

  const client = new Client(
    { name: "mcp-smoke-test", version: "1.0.0" },
    { capabilities: {} }
  );

  await client.connect(transport);

  const results: TestResult[] = [];

  async function test(
    name: string,
    toolArgs: Record<string, unknown> = {},
    validate?: (text: string) => void
  ) {
    const start = Date.now();
    try {
      const { isError, text } = await callTool(client, name, toolArgs);
      const duration = Date.now() - start;

      if (isError) {
        results.push({ tool: name, status: "fail", duration, error: preview(text), preview: preview(text) });
        return null;
      }

      if (validate) {
        validate(text);
      }

      results.push({ tool: name, status: "pass", duration, preview: preview(text) });
      return text;
    } catch (err) {
      const duration = Date.now() - start;
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ tool: name, status: "fail", duration, error: msg });
      return null;
    }
  }

  function assert(condition: boolean, message: string) {
    if (!condition) throw new Error(message);
  }

  console.log(`\nMCP Smoke Test — ${apiUrl} — ${projectRef}\n`);

  // 1. search_docs (no auth needed)
  await test("search_docs", { query: "how to create a task" }, (text) => {
    assert(text.includes("http"), "Expected doc links in response");
  });

  // 2. list_orgs
  await test("list_orgs");

  // 3. list_projects
  await test("list_projects");

  // 4. whoami
  await test("whoami", {}, (text) => {
    assert(text.includes("Profile:"), "Expected profile info");
    assert(text.includes("Email:"), "Expected email");
  });

  // 5. list_profiles
  await test("list_profiles", {}, (text) => {
    assert(text.includes("default"), "Expected default profile");
  });

  // 6. get_current_worker
  const workerText = await test("get_current_worker", commonArgs, (text) => {
    assert(text.includes("tasks registered"), "Expected task count");
    assert(!text.includes("payloadSchema"), "Should NOT contain inline payload schemas");
  });

  // 7. get_task_schema — pick a task from worker output
  if (workerText) {
    const taskMatch = workerText.match(/^- (\S+) in /m);
    if (taskMatch) {
      await test("get_task_schema", { ...commonArgs, taskSlug: taskMatch[1] }, (text) => {
        assert(text.includes("File:"), "Expected file path");
      });
    }
  }

  // 8. list_runs
  const runsText = await test("list_runs", { ...commonArgs, limit: 3 }, (text) => {
    assert(text.includes("Found"), "Expected run count");
  });

  // 9. get_run_details — pick a run from list output
  if (runsText) {
    const runMatch = runsText.match(/run_\w+/);
    if (runMatch) {
      await test("get_run_details", { ...commonArgs, runId: runMatch[0], maxTraceLines: 10 }, (text) => {
        assert(text.includes("Run Details"), "Expected run details header");
        assert(text.includes("Run Trace"), "Expected trace section");
      });
    }
  }

  // 10. list_deploys
  await test("list_deploys", { ...commonArgs, environment: "prod", limit: 3 });

  // 11. list_preview_branches
  await test("list_preview_branches", { projectRef });

  // 12. get_query_schema — single table
  await test("get_query_schema", { ...commonArgs, table: "runs" }, (text) => {
    assert(text.includes("runs"), "Expected runs table");
    assert(text.includes("run_id"), "Expected run_id column");
    assert(!text.includes("### metrics"), "Should NOT contain other tables");
  });

  // 13. get_query_schema — invalid table shows available
  await test("get_query_schema", { ...commonArgs, table: "nonexistent" }).then(() => {
    // This should fail — flip the result
    const last = results[results.length - 1]!;
    if (last.status === "fail" && last.error?.includes("not found")) {
      last.status = "pass";
      last.preview = "Correctly rejected invalid table";
      last.error = undefined;
    }
  });

  // 14. query
  await test("query", { ...commonArgs, query: "SELECT status, count() as total FROM runs GROUP BY status ORDER BY total DESC LIMIT 5", period: "7d" }, (text) => {
    assert(text.includes("Query Results"), "Expected results header");
    assert(text.includes("status"), "Expected status column");
    assert(!text.includes("```json"), "Should use text table, not JSON code block");
  });

  // 15. list_dashboards
  await test("list_dashboards", commonArgs, (text) => {
    assert(text.includes("overview"), "Expected overview dashboard");
    assert(text.includes("llm"), "Expected llm dashboard");
  });

  // 16. run_dashboard_query
  await test("run_dashboard_query", { ...commonArgs, dashboardKey: "overview", widgetId: "9lDDdebQ", period: "7d" }, (text) => {
    assert(text.includes("Total runs"), "Expected widget title");
  });

  // 17. dev_server_status (should show stopped)
  await test("dev_server_status", {}, (text) => {
    assert(text.includes("stopped"), "Expected stopped status");
  });

  // Print results
  await client.close();

  console.log("");
  console.log("─".repeat(90));
  console.log("");

  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const r of results) {
    const icon = r.status === "pass" ? "✓" : r.status === "fail" ? "✗" : "○";
    const dur = `${r.duration}ms`.padStart(6);
    const status = r.status === "pass" ? "\x1b[32mpass\x1b[0m" : r.status === "fail" ? "\x1b[31mfail\x1b[0m" : "\x1b[33mskip\x1b[0m";

    console.log(`  ${icon} ${r.tool.padEnd(25)} ${status} ${dur}  ${r.error ?? r.preview ?? ""}`);

    if (r.status === "pass") passed++;
    else if (r.status === "fail") failed++;
    else skipped++;
  }

  console.log("");
  console.log(`  ${passed} passed, ${failed} failed, ${skipped} skipped (${results.length} total)`);
  console.log("");

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
