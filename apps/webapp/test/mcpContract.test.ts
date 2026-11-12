import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { toolsMetadata } from "../../../packages/cli-v3/src/mcp/config";
import { registerTools } from "../../../packages/cli-v3/src/mcp/tools";
import { mcpTools } from "~/mcp/registry.server";

// The tool modules import env.server at load; nothing here connects.
const telemetryDisabled = vi.hoisted(() => {
  const saved = process.env.TRIGGER_TELEMETRY_DISABLED;
  delete process.env.TRIGGER_TELEMETRY_DISABLED;
  process.env.DATABASE_URL ??= "postgresql://u:p@localhost:5432/db";
  process.env.DIRECT_URL ??= "postgresql://u:p@localhost:5432/db";
  process.env.MAGIC_LINK_SECRET ??= "test-magic-link-secret";
  process.env.ENCRYPTION_KEY ??= "0123456789abcdef0123456789abcdef";
  process.env.DEPLOY_REGISTRY_HOST ??= "localhost";
  process.env.V4_DEPLOY_REGISTRY_HOST ??= "localhost";
  process.env.CLICKHOUSE_URL ??= "http://localhost:8123";
  return saved;
});

const LOCAL_ONLY = [
  "whoami",
  "list_profiles",
  "switch_profile",
  "deploy",
  "start_dev_server",
  "stop_dev_server",
  "dev_server_status",
  "initialize_project",
];

const pendingWriteTools: string[] = [];

const UNCONFIRMED_WRITE_TOOLS: Record<string, string> = {
  submit_feedback: "only logs a report about the MCP server, touches no project data",
  send_agent_message: "covered by the start_agent_chat confirmation for that chat",
  close_agent_chat: "covered by the start_agent_chat confirmation for that chat",
};

type CliTool = {
  description?: string;
  inputSchema: z.ZodRawShape;
  annotations?: { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean };
};

// Drives the CLI's own registerTools so name/description/schema come from the real definitions.
function collectCliTools(readonly: boolean) {
  const tools = new Map<string, CliTool>();
  registerTools({
    options: { readonly, skipTelemetry: false },
    server: {
      registerTool: (name: string, config: CliTool) => {
        tools.set(name, config);
      },
    },
  } as any);
  return tools;
}

const cliAll = collectCliTools(false);
const cliReadable = collectCliTools(true);
if (telemetryDisabled !== undefined) process.env.TRIGGER_TELEMETRY_DISABLED = telemetryDisabled;
const cliWriteNames = [...cliAll.keys()].filter((name) => !cliReadable.has(name));

// toolsMetadata also holds keys the CLI never registers (e.g. get_tasks), so use registered tools.
const expectedRead = [...cliReadable.keys()].filter((name) => !LOCAL_ONLY.includes(name)).sort();
const expectedWrite = cliWriteNames
  .filter((name) => !LOCAL_ONLY.includes(name) && !pendingWriteTools.includes(name))
  .sort();
const expectedTools = [...expectedRead, ...expectedWrite].sort();

const toJson = (shape: z.ZodRawShape) => z.toJSONSchema(z.object(shape), { io: "input" });

describe("MCP remote/CLI contract", () => {
  it("registers exactly the CLI read and write tools, each once, and nothing outside toolsMetadata", () => {
    expect(mcpTools.map((t) => t.name).sort()).toEqual(expectedTools);
    for (const { name } of mcpTools) expect(Object.keys(toolsMetadata)).toContain(name);
  });

  it.each(expectedTools)("%s matches the CLI title, description and input schema", (name) => {
    const remote = mcpTools.find((t) => t.name === name)!;
    const cli = cliAll.get(name)!;
    const meta = toolsMetadata[name as keyof typeof toolsMetadata];
    expect(remote.title).toBe(meta.title);
    expect(remote.description).toBe(meta.description);
    expect(remote.annotations?.title).toBe(cli.annotations?.title);
    expect(remote.annotations?.readOnlyHint).toBe(cli.annotations?.readOnlyHint);
    expect(remote.annotations?.destructiveHint).toBe(cli.annotations?.destructiveHint);
    expect(toJson(remote.inputSchema)).toEqual(toJson(cli.inputSchema));
  });

  it("marks every write tool non-read-only", () => {
    for (const name of expectedWrite) {
      expect(mcpTools.find((t) => t.name === name)!.annotations?.readOnlyHint).toBe(false);
    }
  });

  it("holds every write tool for confirmation except the declared exceptions", () => {
    const unconfirmed = mcpTools
      .filter((t) => t.annotations?.readOnlyHint === false && t.confirm !== true)
      .map((t) => t.name)
      .sort();
    expect(unconfirmed).toEqual(Object.keys(UNCONFIRMED_WRITE_TOOLS).sort());
  });

  it("leaves only the agent-chat and session write tools pending", () => {
    expect([...pendingWriteTools].sort()).toEqual(
      cliWriteNames
        .filter((name) => !LOCAL_ONLY.includes(name) && !expectedWrite.includes(name))
        .sort()
    );
    const registered = mcpTools.map((t) => t.name);
    for (const name of pendingWriteTools) expect(registered).not.toContain(name);
  });
});
