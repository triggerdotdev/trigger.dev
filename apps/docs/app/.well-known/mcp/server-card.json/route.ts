import { mcpUrl } from "@/lib/agent-surface";
import { mcpTools } from "@/lib/mcp";

export const dynamic = "force-static";

export function GET() {
  const name = "Trigger.dev Docs MCP";
  return Response.json({
    name,
    description: "Search and read the Trigger.dev documentation",
    version: "1.0.0",
    serverInfo: { name, version: "1.0.0" },
    url: mcpUrl,
    transport: "http",
    capabilities: { tools: true, resources: false },
    authentication: "none",
    tools: mcpTools.map(({ name, description, inputSchema, title, annotations }) => ({
      name,
      description,
      inputSchema,
      annotations: { title, destructiveHint: false, ...annotations },
    })),
  });
}
