import { DASHBOARD_AGENT_ENV_JWT_SCOPES } from "@internal/dashboard-agent/tool-schemas";
import { buildJwtAbility } from "@trigger.dev/rbac";
import { describe, expect, it, vi } from "vitest";

vi.mock("~/env.server", () => ({ env: { SESSION_SECRET: "secret" } }));
vi.mock("~/db.server", () => ({ prisma: {}, $replica: {} }));

import { DASHBOARD_AGENT_UAT_CAP } from "~/services/dashboardAgent.server";

/**
 * The agent reaches the API two ways, and they are authorized by different lists.
 *
 * Most tools spend an environment JWT minted with a fixed set of scopes; the delegated
 * token's own cap only ceilings that exchange. A few call the API as the delegated token
 * itself. A route whose resource is in neither list answers 403 — which reaches the model
 * as missing data, not as a permission problem, and it then tells the user the thing does
 * not exist. That is how a queue holding 4800 runs was reported as never created.
 */
type Read = { tool: string; path: string; resource: { type: string; id?: string } };

const VIA_ENV_JWT: Read[] = [
  { tool: "list_runs", path: "/api/v1/runs", resource: { type: "runs" } },
  { tool: "get_run_trace", path: "/api/v1/runs/:id/trace", resource: { type: "runs" } },
  { tool: "list_errors", path: "/api/v1/errors", resource: { type: "errors" } },
  { tool: "get_error", path: "/api/v1/errors/:id", resource: { type: "errors" } },
  { tool: "list_deploys", path: "/api/v1/deployments", resource: { type: "deployments" } },
  { tool: "get_deploy", path: "/api/v1/deployments/current", resource: { type: "deployments" } },
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
];

const VIA_DELEGATED_TOKEN: Read[] = [
  {
    tool: "list_environments",
    path: "/api/v1/projects/:ref/environments",
    resource: { type: "environments" },
  },
  {
    tool: "repo snapshot",
    path: "/api/v1/projects/:ref/:env/repo/snapshot",
    resource: { type: "apiKeys" },
  },
];

describe("what the agent's environment JWT may read", () => {
  const ability = buildJwtAbility([...DASHBOARD_AGENT_ENV_JWT_SCOPES]);

  it.each(VIA_ENV_JWT)("$tool reads $path", ({ resource }) => {
    expect(ability.can("read", resource)).toBe(true);
  });
});

describe("what the agent's delegated token may read", () => {
  const ability = buildJwtAbility(DASHBOARD_AGENT_UAT_CAP);

  it.each(VIA_DELEGATED_TOKEN)("$tool reads $path", ({ resource }) => {
    expect(ability.can("read", resource)).toBe(true);
  });

  it("ceilings the exchange: every JWT scope is one the cap already allows", () => {
    // The exchange clamps against this cap, so a scope missing here is silently dropped
    // from the minted JWT rather than refused loudly.
    for (const scope of DASHBOARD_AGENT_ENV_JWT_SCOPES) {
      expect(DASHBOARD_AGENT_UAT_CAP, scope).toContain(scope);
    }
  });

  it("carries read:queues on both sides, since read:query only buys the metrics", () => {
    // A queue's own row — paused, depth, limit — is a `queues` read; its metrics are a
    // `query` read. Drop the scope and the live lookup 403s, which the model reads as a
    // queue that was never created.
    expect(DASHBOARD_AGENT_ENV_JWT_SCOPES).toContain("read:queues");
    expect(DASHBOARD_AGENT_UAT_CAP).toContain("read:queues");
    expect(buildJwtAbility(["read:query"]).can("read", { type: "queues" })).toBe(false);
  });

  it("stays read-only on both sides", () => {
    for (const scope of [...DASHBOARD_AGENT_UAT_CAP, ...DASHBOARD_AGENT_ENV_JWT_SCOPES]) {
      expect(scope.startsWith("read:"), scope).toBe(true);
    }
    expect(ability.can("write", { type: "runs" })).toBe(false);
    expect(ability.canSuper()).toBe(false);
  });
});
