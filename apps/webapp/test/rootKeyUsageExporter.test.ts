import type { MetricsV1Input } from "@internal/clickhouse";
import { redisTest } from "@internal/testcontainers";
import Redis from "ioredis";
import { expect } from "vitest";
import { exportRootKeyUsage } from "~/services/rootKeyUsageExporter.server";

// Catches: replicas multiplying usage events, or run-token observations suppressing root-key evidence.
redisTest(
  "coalesces across replicas independently for each tenant usage signal",
  async ({ redisOptions }) => {
    const first = new Redis(redisOptions);
    const second = new Redis(redisOptions);
    const emitted: MetricsV1Input[] = [];
    const outcomes: string[] = [];
    const row: MetricsV1Input = {
      organization_id: "org_1",
      project_id: "proj_1",
      environment_id: "env_1",
      metric_name: "authenticated_run",
      metric_type: "gauge",
      metric_subject: "",
      bucket_start: "2026-01-01 00:00:00",
      value: Date.UTC(2026, 0, 1),
      attributes: {},
    };
    const emit = (value: MetricsV1Input) => {
      emitted.push(value);
    };
    const outcome = (result: string, count: number) => {
      if (count) outcomes.push(result);
    };

    try {
      await Promise.all([
        exportRootKeyUsage([row], first, emit, outcome),
        exportRootKeyUsage([row], second, emit, outcome),
      ]);
      expect(emitted).toHaveLength(1);
      expect(outcomes.sort()).toEqual(["coalesced", "emitted"]);

      await exportRootKeyUsage([{ ...row, metric_name: "task_hint" }], second, emit, outcome);
      expect(emitted.map((value) => value.metric_name).sort()).toEqual([
        "authenticated_run",
        "task_hint",
      ]);
      expect(await first.ttl("root-key-usage:env_1:task_hint")).toBeGreaterThan(0);
      await first.del("root-key-usage:env_1:task_hint");
      await exportRootKeyUsage([{ ...row, metric_name: "task_hint" }], first, emit, outcome);
      expect(emitted).toHaveLength(3);
    } finally {
      await Promise.all([first.quit(), second.quit()]);
    }
  }
);
