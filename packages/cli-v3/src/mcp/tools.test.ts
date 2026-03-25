/**
 * CLI utility for testing MCP tools.
 *
 * Usage:
 *   npx tsx src/mcp/test-tools.ts [--api-url URL] [command] [args...]
 *
 * Commands:
 *   list                     List all registered tools
 *   call <tool> [json-args]  Call a tool with optional JSON arguments
 *
 * Examples:
 *   npx tsx src/mcp/test-tools.ts list
 *   npx tsx src/mcp/test-tools.ts call get_query_schema '{"environment":"prod"}'
 *   npx tsx src/mcp/test-tools.ts call list_dashboards
 *   npx tsx src/mcp/test-tools.ts call query '{"query":"SELECT count() FROM runs","period":"7d"}'
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  const args = process.argv.slice(2);

  // Parse --api-url flag
  let apiUrl = "http://localhost:3030";
  const apiUrlIdx = args.indexOf("--api-url");
  if (apiUrlIdx !== -1) {
    apiUrl = args[apiUrlIdx + 1] ?? apiUrl;
    args.splice(apiUrlIdx, 2);
  }

  // Parse --readonly flag
  const readonlyIdx = args.indexOf("--readonly");
  const readonly = readonlyIdx !== -1;
  if (readonly) {
    args.splice(readonlyIdx, 1);
  }

  const command = args[0] ?? "list";

  // Spawn the MCP server as a subprocess
  const cliPath = path.resolve(__dirname, "..", "..", "dist", "esm", "index.js");
  const mcpArgs = [cliPath, "mcp", "--api-url", apiUrl];
  if (readonly) {
    mcpArgs.push("--readonly");
  }

  const transport = new StdioClientTransport({
    command: "node",
    args: mcpArgs,
    stderr: "pipe",
  });

  const client = new Client(
    { name: "mcp-test-cli", version: "1.0.0" },
    { capabilities: {} }
  );

  await client.connect(transport);

  try {
    if (command === "list") {
      const { tools } = await client.listTools();
      console.log(`\n${tools.length} tools registered:\n`);
      for (const tool of tools) {
        const params = tool.inputSchema?.properties
          ? Object.keys(tool.inputSchema.properties as Record<string, unknown>).join(", ")
          : "";
        console.log(`  ${tool.name}(${params})`);
        if (tool.description) {
          // Show first line of description
          const firstLine = tool.description!.split("\n")[0]!.slice(0, 100);
          console.log(`    ${firstLine}`);
        }
        console.log();
      }
    } else if (command === "call") {
      const toolName = args[1];
      if (!toolName) {
        console.error("Usage: call <tool-name> [json-arguments]");
        process.exit(1);
      }

      let toolArgs: Record<string, unknown> = {};
      if (args[2]) {
        try {
          toolArgs = JSON.parse(args[2]);
        } catch {
          console.error(`Invalid JSON arguments: ${args[2]}`);
          process.exit(1);
        }
      }

      console.log(`\nCalling ${toolName}...`);
      if (Object.keys(toolArgs).length > 0) {
        console.log(`Arguments: ${JSON.stringify(toolArgs, null, 2)}`);
      }
      console.log();

      const result = await client.callTool({ name: toolName, arguments: toolArgs });

      if (result.isError) {
        console.error("Error:", JSON.stringify(result.content, null, 2));
        process.exit(1);
      }

      for (const item of result.content as Array<{ type: string; text?: string }>) {
        if (item.type === "text" && item.text) {
          console.log(item.text);
        } else {
          console.log(JSON.stringify(item, null, 2));
        }
      }
    } else {
      console.error(`Unknown command: ${command}`);
      console.error("Available commands: list, call");
      process.exit(1);
    }
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
