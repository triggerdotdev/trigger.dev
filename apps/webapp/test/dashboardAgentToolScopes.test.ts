import { buildJwtAbility } from "@trigger.dev/rbac";
import { describe, expect, it, vi } from "vitest";

vi.mock("~/env.server", () => ({ env: { SESSION_SECRET: "secret" } }));
vi.mock("~/db.server", () => ({ prisma: {}, $replica: {} }));

import { DASHBOARD_AGENT_UAT_CAP } from "~/services/dashboardAgent.server";

/**
 * Every API the agent's tools call, against the resource that route authorizes on. A tool
 * whose route needs a resource the cap doesn't carry fails with a 403 the model cannot
 * see as a permission problem — it reads as missing data, which is how `get_queue` came to
 * report a queue of 4800 runs as non-existent.
 */
const TOOL_READS: { tool: string; path: string; resource: { type: string; id?: string } }[] = [
  { tool: "list_runs", path: "/api/v1/runs", resource: { type: "runs" } },
  { tool: "get_run_trace", path: "/api/v1/runs/:id/trace", resource: { type: "runs" } },
  { tool: "list_errors", path: "/api/v1/errors", resource: { type: "errors" } },
  { tool: "get_error", path: "/api/v1/errors/:id", resource: { type: "errors" } },
  { tool: "list_deploys", path: "/api/v1/deployments", resource: { type: "deployments" } },
  { tool: "get_deploy", path: "/api/v1/deployments/current", resource: { type: "deployments" } },
  {
    tool: "list_environments",
    path: "/api/v1/projects/:ref/environments",
    resource: { type: "environments" },
  },
  {
    tool: "get_query_schema",
    path: "/api/v1/query/schema",
    resource: { type: "query", id: "schema" },
  },
  { tool: "run_query", path: "/api/v1/query", resource: { type: "query", id: "runs" } },
  {
    tool: "get_queue (metrics)",
    path: "/api/v1/queues/:name/metrics",
    resource: { type: "query", id: "queue_metrics" },
  },
  { tool: "get_queue (live row)", path: "/api/v1/queues/:name", resource: { type: "queues" } },
  {
    tool: "get_report",
    path: "/api/v1/reports/:key",
    resource: { type: "query", id: "env_metrics" },
  },
  {
    tool: "repo snapshot",
    path: "/api/v1/projects/:ref/:env/repo/snapshot",
    resource: { type: "apiKeys" },
  },
];

describe("the agent's token can do what its tools ask", () => {
  const ability = buildJwtAbility(DASHBOARD_AGENT_UAT_CAP);

  it.each(TOOL_READS)("$tool reads $path", ({ resource }) => {
    expect(ability.can("read", resource)).toBe(true);
  });

  it("stays read-only", () => {
    expect(DASHBOARD_AGENT_UAT_CAP.every((scope) => scope.startsWith("read:"))).toBe(true);
    expect(ability.can("write", { type: "runs" })).toBe(false);
    expect(ability.can("trigger", { type: "tasks" })).toBe(false);
    expect(ability.canSuper()).toBe(false);
  });
});
