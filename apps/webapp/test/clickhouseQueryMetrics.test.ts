import { ClickHouse } from "@internal/clickhouse";
import { containerTest } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";
import { RunsRepository } from "~/services/runsRepository/runsRepository.server";
import {
  createRun,
  insertTaskRunV2Rows,
  seedParents,
} from "./helpers/apiRunListPresenterTestHelpers";
import { createInMemoryMetrics } from "./utils/tracing";
import { histogramCount, latestMetrics, metricSum } from "./otlpMetrics.helpers";

vi.mock("~/db.server", () => ({ prisma: {}, $replica: {} }));

vi.setConfig({ testTimeout: 90_000 });

describe("clickhouse query metrics", () => {
  containerTest(
    "records duration + read_rows on success and an error metric with the ClickHouse error type",
    async ({ clickhouseContainer, prisma }) => {
      const ctx = await seedParents(prisma, "chm");
      const run = await createRun(prisma, ctx, { friendlyId: "run_chm" });

      const seedClient = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "clickhouse-metrics-seed",
      });
      await insertTaskRunV2Rows(seedClient, [{ ...run, createdAt: new Date() }]);

      const listArgs = {
        page: { size: 10 } as const,
        organizationId: ctx.organizationId,
        projectId: ctx.projectId,
        environmentId: ctx.environmentId,
      };

      const okMetrics = createInMemoryMetrics();
      const okClient = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "clickhouse-metrics-ok",
        meter: okMetrics.meter,
      });
      const okRepo = new RunsRepository({ prisma, clickhouse: okClient });
      const result = await okRepo.listRuns(listArgs);
      expect(result.runs.map((r) => r.friendlyId)).toEqual(["run_chm"]);

      await vi.waitFor(
        async () => {
          const rm = await latestMetrics(okMetrics);
          expect(
            histogramCount(rm, "clickhouse.query.duration", {
              client: "clickhouse-metrics-ok",
              status: "ok",
            })
          ).toBeGreaterThanOrEqual(1);
        },
        { timeout: 5000, interval: 50 }
      );
      const okRm = await latestMetrics(okMetrics);
      expect(
        histogramCount(okRm, "clickhouse.query.read_rows", { client: "clickhouse-metrics-ok" })
      ).toBeGreaterThanOrEqual(1);
      expect(
        histogramCount(okRm, "clickhouse.query.memory_usage", { client: "clickhouse-metrics-ok" })
      ).toBeGreaterThanOrEqual(1);
      await okMetrics.shutdown();

      const errMetrics = createInMemoryMetrics();
      const cappedClient = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "clickhouse-metrics-capped",
        clickhouseSettings: { max_memory_usage: "1" },
        meter: errMetrics.meter,
      });
      const errRepo = new RunsRepository({ prisma, clickhouse: cappedClient });
      await expect(errRepo.listRuns(listArgs)).rejects.toThrow();

      await vi.waitFor(
        async () => {
          const rm = await latestMetrics(errMetrics);
          expect(
            metricSum(rm, "clickhouse.query.errors", {
              client: "clickhouse-metrics-capped",
              error_type: "MEMORY_LIMIT_EXCEEDED",
            })
          ).toBeGreaterThanOrEqual(1);
        },
        { timeout: 5000, interval: 50 }
      );
      await errMetrics.shutdown();
    }
  );
});
