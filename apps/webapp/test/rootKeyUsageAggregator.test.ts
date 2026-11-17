import type { MetricsV1Input } from "@internal/clickhouse";
import { describe, expect, it } from "vitest";
import { createRootKeyUsageAggregator } from "~/services/rootKeyUsageAggregator.server";

const environment = { id: "env_1", organizationId: "org_1", projectId: "proj_1" };
const startedAt = Date.UTC(2026, 0, 1);

function request(headers: Record<string, string> = {}) {
  return new Request("https://api.example.com", { headers });
}

function setup(maxEntries = 10) {
  const rows: MetricsV1Input[] = [];
  let dropped = 0;
  let now = startedAt;
  const usage = createRootKeyUsageAggregator({
    bucketSeconds: 300,
    maxEntries,
    now: () => now,
    counters: { dropped: { add: (count) => (dropped += count) } },
    sink: (batch) => {
      rows.push(...batch);
    },
  });
  return { usage, rows, dropped: () => dropped, setNow: (value: number) => (now = value) };
}

describe("tenant root-key usage", () => {
  // Catches: backend root-key traffic or a forged run header being treated as authenticated task usage.
  it("separates hinted root use, authenticated runs and unknown origins using authenticated tenancy", () => {
    const { usage, rows } = setup();
    usage.record(request(), "root_api_key", environment);
    usage.record(
      request({ "x-trigger-worker": "true", "x-trigger-organization-id": "org_forged" }),
      "root_api_key",
      environment
    );
    usage.record(request({ "x-trigger-run-id": "run_forged" }), "root_api_key", environment);
    usage.record(request(), "run_token", environment);
    usage.record(request({ "x-trigger-worker": "true" }), "public_jwt", environment);
    usage.flush();

    expect(rows.map((row) => row.metric_name).sort()).toEqual([
      "authenticated_run",
      "task_hint",
      "unknown_origin",
    ]);
    expect(rows.every((row) => row.organization_id === environment.organizationId)).toBe(true);
    expect(rows.every((row) => row.environment_id === environment.id)).toBe(true);
  });

  // Catches: default or named fallbacks missing from last use, or flush time replacing observation time.
  it("coalesces default, named fallback and explicit root requests without keeping operation histories", () => {
    const { usage, rows, setNow } = setup();
    for (const operation of ["default", "listSchedules"]) {
      usage.record(
        request({
          "x-trigger-sdk-operation": operation,
          "x-trigger-sdk-credential-reason": "unsupported_operation",
        }),
        "root_api_key",
        environment
      );
    }
    const explicitRoot = request({ "x-trigger-worker": "true" });
    setNow(startedAt + 1_000);
    usage.record(explicitRoot, "root_api_key", environment);
    setNow(startedAt + 2_000);
    usage.record(explicitRoot, "root_api_key", environment);
    expect(rows).toHaveLength(0);
    setNow(startedAt + 30_000);
    usage.flush();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.metric_name).toBe("task_hint");
    expect(rows[0]?.value).toBe(startedAt + 1_000);
    expect(usage.flush()).toBe(0);
  });

  // Catches: tenant saturation silently implying coverage, or arbitrary SDK headers entering stored dimensions.
  it("reports bounded-buffer loss and discards unrecognized selection hints", () => {
    const { usage, rows, dropped } = setup(1);
    usage.record(
      request({
        "x-trigger-sdk-operation": "untrusted-secret-value",
        "x-trigger-sdk-credential-reason": "untrusted-secret-value",
      }),
      "root_api_key",
      environment
    );
    usage.record(request(), "root_api_key", { ...environment, id: "env_2" });
    usage.flush();
    expect(dropped()).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metric_name).toBe("unknown_origin");
    expect(JSON.stringify(rows)).not.toContain("untrusted-secret-value");
  });
});
