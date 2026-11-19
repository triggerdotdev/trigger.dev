import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpContext } from "./context.js";
import { registerTools } from "./tools.js";

const read = { readOnlyHint: true, destructiveHint: false };
const write = { readOnlyHint: false, destructiveHint: true };

const TOOLS: Record<string, typeof read> = {
  search_docs: read,
  list_orgs: read,
  list_projects: read,
  get_current_worker: read,
  get_task_schema: read,
  list_runs: read,
  get_run_details: read,
  get_span_details: read,
  wait_for_run_to_complete: read,
  list_deploys: read,
  list_preview_branches: read,
  get_query_schema: read,
  query: read,
  list_dashboards: read,
  run_dashboard_query: read,
  whoami: read,
  list_profiles: read,
  switch_profile: read,
  start_dev_server: read,
  stop_dev_server: read,
  dev_server_status: read,
  list_prompts: read,
  get_prompt_versions: read,
  list_agents: read,
  read_session_channel: read,
  get_report: read,
  list_alert_capabilities: read,
  list_alerts: read,
  list_webhook_endpoints: read,
  get_webhook_endpoint_details: read,
  list_webhook_deliveries: read,
  get_webhook_delivery: read,
  submit_feedback: write,
  create_project_in_org: write,
  initialize_project: write,
  trigger_task: write,
  cancel_run: write,
  replay_run: write,
  deploy: write,
  create_dashboard: write,
  set_dashboard_widgets: write,
  promote_prompt_version: write,
  create_prompt_override: write,
  update_prompt_override: write,
  remove_prompt_override: write,
  reactivate_prompt_override: write,
  start_agent_chat: write,
  send_agent_message: write,
  close_agent_chat: write,
  write_session_channel: write,
  create_alert: write,
  resolve_alert: write,
  replay_webhook_delivery: write,
  generate_webhook_secret: write,
  set_webhook_secret: write,
};

const TELEMETRY_ONLY = ["submit_feedback"];

async function registeredHints(skipTelemetry: boolean) {
  const server = new McpServer({ name: "trigger.dev", version: "test" });
  registerTools(new McpContext(server, { skipTelemetry }));
  const client = new Client({ name: "annotations-test", version: "test" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  return Object.fromEntries(
    tools.map((tool) => [
      tool.name,
      {
        readOnlyHint: tool.annotations?.readOnlyHint,
        destructiveHint: tool.annotations?.destructiveHint,
      },
    ])
  );
}

describe("CLI MCP tool annotations", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // Catches: a write tool left out of WRITE_TOOLS (advertised read-only, kept under --readonly), a read tool added to it, or a new tool registered without a table entry.
  it.each([
    { telemetry: "off", skipTelemetry: true, hidden: TELEMETRY_ONLY },
    { telemetry: "on", skipTelemetry: false, hidden: [] as string[] },
  ])(
    "registers every tool with its expected hints, telemetry $telemetry",
    async ({ skipTelemetry, hidden }) => {
      vi.stubEnv("TRIGGER_TELEMETRY_DISABLED", undefined);
      const expected = Object.fromEntries(
        Object.entries(TOOLS).filter(([name]) => !hidden.includes(name))
      );
      expect(await registeredHints(skipTelemetry)).toEqual(expected);
    }
  );
});
