import { curateReport } from "@internal/dashboard-agent/tool-curation";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { interpret, type HealthInput } from "~/presenters/v3/reports/health/health";
import { reportResponse } from "~/presenters/v3/reports/reportsApi.server";

/**
 * The real chain the agent's `get_report` runs: the health presenter builds the view model, the
 * reports route serializes it as `format=json`, and the agent curates that body. Nothing here
 * names a `facts` key on the way in, so a producer/consumer rename fails instead of passing.
 */
async function curatedFacts(input: HealthInput): Promise<Record<string, unknown>> {
  const body = await reportResponse(interpret(input), "json").json();
  return curateReport(body).facts as Record<string, unknown>;
}

const HEALTHY: HealthInput = {
  scope: "prod",
  period: "last 1h",
  baselineLabel: "vs your 7d normal",
  generatedAt: "2026-07-20T12:00:00.000Z",
  windowMinutes: 60,
  flowSource: "queue_metrics_v1",
  pending: { now: 84, normal: 120, series: [110, 96, 88, 90, 84], estimated: false },
  startLatency: { p95Ms: 6000, normalP95Ms: 7000, series: [6500, 6200, 6000, 5900, 6000] },
  throughput: {
    finishedPerMin: 1000,
    completedPerMin: 1000,
    triggeredPerMin: 1000,
    normalTriggeredPerMin: 1000,
  },
  failures: { rate: 0.009, normalRate: 0.011, series: [0.01, 0.009, 0.009] },
  duration: { p95Ms: 1100, normalP95Ms: 1180 },
  liveness: { telemetryAgeMs: 2000 },
  flowEvidence: {
    runningSeries: [40, 45, 50, 48, 44],
    envLimit: 100,
    throttledShare: 0,
    worstQueue: null,
    dlqDelta: 0,
  },
};

describe("the agent's curated report keeps the reason its numbers can't be trusted", () => {
  it("carries telemetry_stale", async () => {
    const facts = await curatedFacts({ ...HEALTHY, liveness: { telemetryAgeMs: 30 * 60_000 } });
    expect(facts.trustworthy).toBe(false);
    expect(facts.untrustworthyReason).toBe("telemetry_stale");
  });

  it("carries telemetry_absent", async () => {
    const facts = await curatedFacts({ ...HEALTHY, liveness: { telemetryAgeMs: null } });
    expect(facts.trustworthy).toBe(false);
    expect(facts.untrustworthyReason).toBe("telemetry_absent");
  });

  it("carries flow_unmeasured", async () => {
    const facts = await curatedFacts({
      ...HEALTHY,
      pending: { now: 0, series: [], estimated: true, availability: "unknown" },
    });
    expect(facts.trustworthy).toBe(false);
    expect(facts.untrustworthyReason).toBe("flow_unmeasured");
  });

  it("states no reason on a trustworthy report", async () => {
    const facts = await curatedFacts(HEALTHY);
    expect(facts.trustworthy).toBe(true);
    expect(facts.untrustworthyReason).toBeUndefined();
  });

  // Structural: it reads the import list, so it proves nothing about what the module does at
  // runtime — only that serializing a report doesn't reach the route builder, and `env.server`
  // behind it. The auth resource lives in `reportsApiAuth.server.ts` for that reason.
  it("serializes a report without dragging the route builder in", () => {
    const source = readFileSync(
      new URL("../app/presenters/v3/reports/reportsApi.server.ts", import.meta.url),
      "utf8"
    );
    expect(source).not.toMatch(/routeBuilders|env\.server/);
  });

  it("carries every fact key the presenter emits, so the next rename fails here", async () => {
    const emitted = interpret(HEALTHY).facts;
    const curated = await curatedFacts(HEALTHY);
    // `telemetry` is deliberately dropped: `trustworthy` + the reason already say what the agent acts on.
    const dropped = new Set(["telemetry"]);
    for (const key of Object.keys(emitted)) {
      if (dropped.has(key)) continue;
      expect(Object.keys(curated)).toContain(key);
    }
  });
});
