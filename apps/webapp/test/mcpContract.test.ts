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

const REMOTE_ONLY: Record<string, string> = {
  list_run_tags: "the public API has no endpoint to list run tags",
  search_logs: "the public API has no endpoint to search logs",
  get_log: "the public API has no endpoint to read a log entry",
  reset_run_idempotency_key: "the public API has no endpoint for it; it mirrors a dashboard action",
  update_run_metadata: "the CLI has no tool for it yet",
  add_run_tags: "the CLI has no tool for it yet",
  reschedule_run: "the CLI has no tool for it yet",
  read_run_stream: "the CLI has no tool for it yet",
  list_bulk_actions: "the CLI has no tool for it yet",
  get_bulk_action: "the CLI has no tool for it yet",
  create_bulk_action: "the CLI has no tool for it yet",
  abort_bulk_action: "the CLI has no tool for it yet",
  search_webhook_endpoints:
    "the public endpoints API has no subscriber, source, status or text filters",
  get_task_webhook: "no public API returns a webhook task's file path and subscribed endpoints",
  list_webhook_waiters: "no public API lists the waiters on an endpoint",
  remove_webhook_secret: "the dashboard clears a secret; the public API has no route for it",
  generate_webhook_verify_token: "verification tokens are only generated in the dashboard",
  pause_webhook_endpoint: "the CLI has no MCP twin for the public disable route",
  resume_webhook_endpoint: "the CLI has no MCP twin for the public enable route",
  cancel_webhook_waiter: "the CLI has no MCP tool for the public waiter cancel route",
  list_tasks: "the CLI's get_current_worker lists slugs only; this mirrors the Tasks page",
  list_schedules: "the CLI has no schedule tools yet",
  get_schedule_details: "the CLI has no schedule tools yet",
  create_schedule: "the CLI has no schedule tools yet",
  update_schedule: "the CLI has no schedule tools yet",
  activate_schedule: "the CLI has no schedule tools yet",
  deactivate_schedule: "the CLI has no schedule tools yet",
  delete_schedule: "the CLI has no schedule tools yet",
  get_deployment_details: "the CLI has no tool for it yet",
  get_agent_details: "the public API has no endpoint for an agent's details and activity",
  list_environment_variables: "names only, through OAuth; the CLI has no env var tools",
  get_alert_details: "reads the Dashboard alert presenter, which only the server has",
  list_alert_channels: "reads the Dashboard channel presenter, which only the server has",
  update_alert: "edits through the Dashboard alert services, which only the server has",
  stop_alert: "stops through the Dashboard alert services, which only the server has",
  activate_alert: "activates through the Dashboard alert services, which only the server has",
  delete_alert: "deletes through the Dashboard alert services, which only the server has",
  create_alert_group: "groups through the Dashboard alert services, which only the server has",
  ungroup_alert: "ungroups through the Dashboard alert services, which only the server has",
  list_errors: "the CLI has no tool for it yet",
  get_error_details: "the CLI has no tool for it yet",
  resolve_error: "the CLI has no tool for it yet",
  ignore_error: "the CLI has no tool for it yet",
  unresolve_error: "the CLI has no tool for it yet",
  get_dashboard: "the CLI has no tool for it yet",
  list_query_history: "the public API has no endpoint for the Query page history",
  list_models: "the public API has no endpoint for the model catalogue",
  get_model: "the public API has no endpoint for a model's details",
  get_model_usage: "the public API has no endpoint for model usage",
  get_prompt: "the CLI has no tool for it yet",
  list_prompt_generations: "the public API has no endpoint for a prompt's generations",
  update_dashboard_widget: "the CLI has no tool for it yet",
  update_dashboard: "the CLI has no tool for it yet",
  delete_dashboard: "the CLI has no tool for it yet",
  list_sessions: "the CLI has no tool for it yet",
  get_session_details: "no public API returns a session's runs and channel names",
  read_session_transcript: "the CLI has no tool for it yet",
  list_playground_conversations: "playground conversations are only listed in the dashboard",
  update_session: "the CLI has no tool for it yet",
  close_session: "the CLI has no tool for it yet",
  list_batches: "the public API has no endpoint to list batches",
  get_batch_details: "the CLI has no tool for it yet",
  list_waitpoint_tokens: "the CLI has no tool for it yet",
  get_waitpoint_token: "the CLI has no tool for it yet",
  complete_waitpoint_token: "the CLI has no tool for it yet",
};

const WRITE_TOOL_APPROVAL: Record<string, "required" | "configurable" | { none: string }> = {
  replay_webhook_delivery: "required",
  generate_webhook_secret: "required",
  set_webhook_secret: "required",
  remove_webhook_secret: "required",
  generate_webhook_verify_token: "required",
  pause_webhook_endpoint: "configurable",
  resume_webhook_endpoint: "configurable",
  cancel_webhook_waiter: "configurable",
  complete_waitpoint_token: "required",
  submit_feedback: { none: "only logs a report about the MCP server, touches no project data" },
  send_agent_message: { none: "covered by the start_agent_chat confirmation for that chat" },
  close_agent_chat: { none: "covered by the start_agent_chat confirmation for that chat" },
  cancel_run: "configurable",
  replay_run: "configurable",
  reset_run_idempotency_key: "configurable",
  update_run_metadata: "configurable",
  add_run_tags: "configurable",
  reschedule_run: "configurable",
  create_bulk_action: "required",
  abort_bulk_action: "configurable",
  trigger_task: "configurable",
  create_alert: "configurable",
  resolve_alert: "configurable",
  update_alert: "configurable",
  stop_alert: "configurable",
  activate_alert: "configurable",
  delete_alert: "required",
  create_alert_group: "configurable",
  ungroup_alert: "required",
  create_dashboard: "configurable",
  set_dashboard_widgets: "configurable",
  update_dashboard_widget: "configurable",
  update_dashboard: "configurable",
  delete_dashboard: "required",
  promote_prompt_version: "configurable",
  create_prompt_override: "configurable",
  update_prompt_override: "configurable",
  remove_prompt_override: "configurable",
  reactivate_prompt_override: "configurable",
  start_agent_chat: "configurable",
  write_session_channel: "configurable",
  update_session: "configurable",
  close_session: "configurable",
  create_project_in_org: "configurable",
  create_schedule: "configurable",
  update_schedule: "configurable",
  activate_schedule: "configurable",
  deactivate_schedule: "configurable",
  delete_schedule: "required",
  resolve_error: "configurable",
  ignore_error: "configurable",
  unresolve_error: "configurable",
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

// The formats JSON Schema 2020-12 defines. Anything else is a custom format a client may not know.
const STANDARD_FORMATS = new Set([
  "date-time",
  "date",
  "time",
  "duration",
  "email",
  "idn-email",
  "hostname",
  "idn-hostname",
  "ipv4",
  "ipv6",
  "uri",
  "uri-reference",
  "iri",
  "iri-reference",
  "uuid",
  "uri-template",
  "json-pointer",
  "relative-json-pointer",
  "regex",
]);

function formatsIn(node: unknown, found: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) formatsIn(item, found);
  } else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "format" && typeof value === "string") found.push(value);
      else formatsIn(value, found);
    }
  }
  return found;
}

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

  // Catches: a string check (startsWith, endsWith, includes, lowercase, ...) that zod prints as a
  // custom `format`, which JSON Schema validators in strict mode refuse to compile.
  it("advertises only standard JSON Schema formats in input schemas", () => {
    const tools = [
      ...mcpTools.map((t) => ({ name: `remote ${t.name}`, shape: t.inputSchema })),
      ...[...cliAll].map(([name, t]) => ({ name: `cli ${name}`, shape: t.inputSchema })),
    ];
    const custom = tools.flatMap(({ name, shape }) =>
      formatsIn(toJson(shape))
        .filter((format) => !STANDARD_FORMATS.has(format))
        .map((format) => `${name}: ${format}`)
    );
    expect(custom).toEqual([]);
  });
});
