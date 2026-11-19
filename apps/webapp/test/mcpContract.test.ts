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

const REMOTE_ONLY: Record<string, string> = {};

const WRITE_TOOL_APPROVAL: Record<string, "required" | "configurable" | { none: string }> = {
  replay_webhook_delivery: "required",
  generate_webhook_secret: "required",
  set_webhook_secret: "required",
  submit_feedback: { none: "only logs a report about the MCP server, touches no project data" },
  send_agent_message: { none: "covered by the start_agent_chat confirmation for that chat" },
  close_agent_chat: { none: "covered by the start_agent_chat confirmation for that chat" },
  cancel_run: "configurable",
  replay_run: "configurable",
  trigger_task: "configurable",
  create_alert: "configurable",
  resolve_alert: "configurable",
  create_dashboard: "configurable",
  set_dashboard_widgets: "configurable",
  promote_prompt_version: "configurable",
  create_prompt_override: "configurable",
  update_prompt_override: "configurable",
  remove_prompt_override: "configurable",
  reactivate_prompt_override: "configurable",
  start_agent_chat: "configurable",
  write_session_channel: "configurable",
  create_project_in_org: "configurable",
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

function classifyHostedTools(hosted: string[], cli: string[], remoteOnly: string[]) {
  const cliSet = new Set(cli);
  const remoteOnlySet = new Set(remoteOnly);
  return {
    shared: hosted.filter((name) => cliSet.has(name)).sort(),
    undeclared: hosted.filter((name) => !cliSet.has(name) && !remoteOnlySet.has(name)).sort(),
    remoteOnlyWithCliTwin: remoteOnly.filter((name) => cliSet.has(name)).sort(),
    remoteOnlyUnregistered: remoteOnly.filter((name) => !hosted.includes(name)).sort(),
  };
}

const toJson = (shape: z.ZodRawShape) => z.toJSONSchema(z.object(shape), { io: "input" });

describe("MCP remote/CLI contract", () => {
  // Catches: a hosted tool with no CLI twin slipping in undeclared, a REMOTE_ONLY entry with a CLI twin, or a stale REMOTE_ONLY entry.
  it("registers exactly the CLI read and write tools plus declared remote-only tools, each once, and nothing outside toolsMetadata", () => {
    const hosted = mcpTools.map((t) => t.name);
    const result = classifyHostedTools(hosted, [...cliAll.keys()], Object.keys(REMOTE_ONLY));
    expect(result.undeclared).toEqual([]);
    expect(result.remoteOnlyWithCliTwin).toEqual([]);
    expect(result.remoteOnlyUnregistered).toEqual([]);
    expect(result.shared).toEqual(expectedTools);
    expect([...hosted].sort()).toEqual([...expectedTools, ...Object.keys(REMOTE_ONLY)].sort());
    for (const name of hosted) {
      if (!(name in REMOTE_ONLY)) expect(Object.keys(toolsMetadata)).toContain(name);
    }
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

  // Catches: a CLI or remote-only write tool advertised as read-only.
  it("marks every write tool non-read-only", () => {
    const remoteOnlyWrite = Object.keys(REMOTE_ONLY).filter((name) => name in WRITE_TOOL_APPROVAL);
    for (const name of [...expectedWrite, ...remoteOnlyWrite]) {
      expect(mcpTools.find((t) => t.name === name)!.annotations?.readOnlyHint).toBe(false);
    }
  });

  // Catches: a write tool (by annotations, class, CLI twin or write auth) with no approval class or a wrong one, or a class that disagrees with whether the gate confirms it.
  it("gives every write tool its approval class, none exactly for the unconfirmed ones", () => {
    const writeTools = mcpTools.filter(
      (t) =>
        t.annotations?.readOnlyHint === false ||
        t.approval !== undefined ||
        expectedWrite.includes(t.name) ||
        (t.auth !== undefined && !("public" in t.auth) && t.auth.action !== "read")
    );
    const actual = Object.fromEntries(
      writeTools.map((t) => [t.name, { approval: t.approval, confirms: t.confirm === true }])
    );
    const expected = Object.fromEntries(
      Object.entries(WRITE_TOOL_APPROVAL).map(([name, approval]) => [
        name,
        typeof approval === "string"
          ? { approval, confirms: true }
          : { approval: "none", confirms: false },
      ])
    );
    expect(actual).toEqual(expected);
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
