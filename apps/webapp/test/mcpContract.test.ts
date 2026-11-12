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

const pendingWriteTools = [
  "submit_feedback",
  "create_project_in_org",
  "trigger_task",
  "cancel_run",
  "replay_run",
  "create_dashboard",
  "set_dashboard_widgets",
  "promote_prompt_version",
  "create_prompt_override",
  "update_prompt_override",
  "remove_prompt_override",
  "reactivate_prompt_override",
  "start_agent_chat",
  "send_agent_message",
  "close_agent_chat",
  "write_session_channel",
  "create_alert",
  "resolve_alert",
  "generate_webhook_secret",
  "set_webhook_secret",
  "replay_webhook_delivery",
];

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

const toJson = (shape: z.ZodRawShape) => z.toJSONSchema(z.object(shape), { io: "input" });

describe("MCP remote/CLI contract", () => {
  it("registers exactly the CLI read tools, each once, and nothing outside toolsMetadata", () => {
    expect(mcpTools.map((t) => t.name).sort()).toEqual(expectedRead);
    for (const { name } of mcpTools) expect(Object.keys(toolsMetadata)).toContain(name);
  });

  it.each(expectedRead)("%s matches the CLI title, description and input schema", (name) => {
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

  it("lists the CLI write tools as pending and absent from the registry", () => {
    expect([...pendingWriteTools].sort()).toEqual(
      cliWriteNames.filter((name) => !LOCAL_ONLY.includes(name)).sort()
    );
    const registered = mcpTools.map((t) => t.name);
    for (const name of pendingWriteTools) expect(registered).not.toContain(name);
  });
});
