import { buildJwtAbility } from "@trigger.dev/rbac";
import { describe, expect, it } from "vitest";
import {
  isReportKey,
  reportQueryTables,
  type ReportQueryTable,
} from "~/presenters/v3/reports/report-registry";
import { type ReportViewModel } from "~/presenters/v3/reports/report-view-model";
import {
  reportResponse,
  ReportSearchParamsSchema,
} from "~/presenters/v3/reports/reportsApi.server";
import { reportAuthResource } from "~/presenters/v3/reports/reportsApiAuth.server";

// `everyResource(...)` tags its payload with this Symbol.for marker (see apiBuilder.server.ts).
const EVERY_RESOURCE_MARKER = Symbol.for("@trigger.dev/rbac.everyResource");

/** ANSI CSI introducer: present in the coloured render, absent from markdown. */
const ESC = "\u001b[";

function requiredResources(key: string): { type: string; id: string }[] {
  const resource = reportAuthResource(key) as unknown as {
    [EVERY_RESOURCE_MARKER]: true;
    resources: { type: string; id: string }[];
  };
  expect(resource[EVERY_RESOURCE_MARKER]).toBe(true);
  return resource.resources;
}

function authorizes(scopes: string[], key: string): boolean {
  const ability = buildJwtAbility(scopes);
  const resources = requiredResources(key);
  return resources.length > 0 && resources.every((r) => ability.can("read", r));
}

function healthyViewModel(): ReportViewModel {
  return {
    title: "health",
    scope: "prod",
    period: "last 1h",
    generatedAt: "2026-01-01T00:00:00.000Z",
    windowMinutes: 60,
    summary: {
      severity: "ok",
      statements: [{ findingType: "flow", severity: "ok" }],
    },
    findings: [{ type: "flow", severity: "ok", reason: "healthy", metricIds: [] }],
    metrics: [],
    facts: { runsCompleted: 12 },
    links: [],
    footer: [],
  };
}

describe("api.v1.reports.$key — period contract", () => {
  it("accepts 1h / 24h / 7d", () => {
    for (const period of ["1h", "24h", "7d"]) {
      const parsed = ReportSearchParamsSchema.safeParse({ period });
      expect(parsed.success, period).toBe(true);
    }
  });

  it("accepts minutes and weeks", () => {
    expect(ReportSearchParamsSchema.safeParse({ period: "30m" }).success).toBe(true);
    expect(ReportSearchParamsSchema.safeParse({ period: "2w" }).success).toBe(true);
  });

  // Reports bucket by whole minutes, so seconds are rejected rather than silently rounded.
  it("rejects seconds — 30s and 90s", () => {
    expect(ReportSearchParamsSchema.safeParse({ period: "30s" }).success).toBe(false);
    expect(ReportSearchParamsSchema.safeParse({ period: "90s" }).success).toBe(false);
  });

  it("rejects garbage and absurd ranges", () => {
    expect(ReportSearchParamsSchema.safeParse({ period: "nonsense" }).success).toBe(false);
    expect(ReportSearchParamsSchema.safeParse({ period: "0h" }).success).toBe(false);
    expect(ReportSearchParamsSchema.safeParse({ period: "999999999d" }).success).toBe(false);
  });

  it("defaults format to markdown and rejects an unknown format", () => {
    expect(ReportSearchParamsSchema.parse({}).format).toBe("markdown");
    expect(ReportSearchParamsSchema.safeParse({ format: "yaml" }).success).toBe(false);
  });
});

describe("api.v1.reports.$key — authorization", () => {
  it("passes a JWT scoped to read:query", () => {
    expect(authorizes(["read:query"], "health")).toBe(true);
  });

  it("passes a JWT scoped to every table the report reads", () => {
    const scopes = reportQueryTables("health").map((t) => `read:query:${t}`);
    expect(authorizes(scopes, "health")).toBe(true);
  });

  it("rejects a JWT scoped to only some of the tables the report reads", () => {
    expect(authorizes(["read:query:runs"], "health")).toBe(false);
  });

  it("rejects a JWT with no query scope at all", () => {
    expect(authorizes(["read:runs"], "health")).toBe(false);
  });

  it("requires the health report's tables, not a permissive query:all", () => {
    expect(requiredResources("health")).toEqual([
      { type: "query", id: "runs" },
      { type: "query", id: "env_metrics" },
      { type: "query", id: "queue_metrics" },
    ]);
  });

  it("denies an unknown key outright, however broadly the token is scoped", () => {
    expect(requiredResources("nonsense")).toEqual([]);
    expect(authorizes(["read:query"], "nonsense")).toBe(false);
    expect(authorizes(["admin"], "nonsense")).toBe(false);
  });
});

describe("reportQueryTables — scope derivation from the registry", () => {
  const registry: Record<string, { tables: readonly ReportQueryTable[] }> = {
    health: { tables: ["runs", "env_metrics", "queue_metrics"] },
    narrow: { tables: ["runs"] },
  };

  it("gives a narrower report exactly its own tables", () => {
    expect(reportQueryTables("narrow", registry)).toEqual(["runs"]);
  });

  it("still gives the wider report all of its tables", () => {
    expect(reportQueryTables("health", registry)).toEqual(["runs", "env_metrics", "queue_metrics"]);
  });

  it("returns no tables for an unknown key", () => {
    expect(reportQueryTables("unknown", registry)).toEqual([]);
  });
});

describe("api.v1.reports.$key — formats", () => {
  it("serves json as the raw view model", async () => {
    const vm = healthyViewModel();
    const response = reportResponse(vm, "json");

    expect(response.headers.get("Content-Type")).toContain("application/json");
    await expect(response.json()).resolves.toEqual(vm);
  });

  it("serves markdown as text/markdown", async () => {
    const response = reportResponse(healthyViewModel(), "markdown");

    expect(response.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    const body = await response.text();
    expect(body.length).toBeGreaterThan(0);
    expect(body).not.toContain(ESC);
    expect(body).not.toContain("[");
  });

  it("serves ansi as text/plain with escape codes", async () => {
    const response = reportResponse(healthyViewModel(), "ansi");

    expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(await response.text()).toContain("[");
  });
});

describe("api.v1.reports.$key — report key", () => {
  it("accepts a registered key", () => {
    expect(isReportKey("health")).toBe(true);
  });

  it("rejects an unknown key and prototype keys", () => {
    for (const key of ["nonsense", "toString", "__proto__", "constructor"]) {
      expect(isReportKey(key), key).toBe(false);
    }
  });
});
