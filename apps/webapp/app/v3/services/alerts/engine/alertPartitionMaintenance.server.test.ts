import { postgresTest } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";
import type { ensureAlertHistoryPartitions } from "../storage/alertPartitions.server";
import { runAlertPartitionMaintenance } from "./alertPartitionMaintenance.server";

vi.setConfig({ testTimeout: 120_000 });

describe("runAlertPartitionMaintenance", () => {
  postgresTest(
    "ensures partitions on the ddl client and sweeps seen rows on prisma",
    async ({ prisma }) => {
      const now = new Date("2029-06-15T00:00:00Z");
      await prisma.alertOccurrenceSeen.createMany({
        data: [
          {
            alertId: "alert_1",
            sourceEventId: "expired",
            rowTime: new Date("2029-06-01T00:00:00Z"),
            expiresAt: new Date("2029-06-08T00:00:00Z"),
          },
          {
            alertId: "alert_1",
            sourceEventId: "live",
            rowTime: new Date("2029-06-14T00:00:00Z"),
            expiresAt: new Date("2029-06-21T00:00:00Z"),
          },
        ],
      });
      const ensurePartitions = vi.fn(
        async (_prisma: unknown, _options: { now: Date }) =>
          ({
            created: ["AlertEvent_p202908"],
            dropped: [],
            deferred: [],
            lookaheadMonths: 2,
          }) as Awaited<ReturnType<typeof ensureAlertHistoryPartitions>>
      );
      const logger = { info: vi.fn(), error: vi.fn() };
      const ddl = {} as typeof prisma;
      const ddlClient = { get: () => ddl, discard: vi.fn(async () => {}) };

      const result = await runAlertPartitionMaintenance(
        { now },
        { prisma, ddlClient, logger, ensurePartitions }
      );

      expect(ensurePartitions.mock.calls[0]?.[0]).toBe(ddl);
      expect(ensurePartitions.mock.calls[0]?.[1].now).toBe(now);
      expect(result).toEqual({
        created: ["AlertEvent_p202908"],
        dropped: [],
        deferred: [],
        sweptSeen: 1,
      });
      expect(logger.info).toHaveBeenCalledWith("alerts.partitions.maintenance", result);
      const remaining = await prisma.alertOccurrenceSeen.findMany({
        select: { sourceEventId: true },
      });
      expect(remaining.map((r) => r.sourceEventId)).toEqual(["live"]);

      ensurePartitions.mockResolvedValueOnce({
        created: [],
        dropped: [],
        deferred: [],
        lookaheadMonths: 2,
        connectionStuck: true,
      });
      await runAlertPartitionMaintenance({ now }, { prisma, ddlClient, logger, ensurePartitions });
      expect(ddlClient.discard).toHaveBeenCalledOnce();
    }
  );
});
