import { ClickHouse } from "@internal/clickhouse";
import { containerTest } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";
import { RunsRepository } from "~/services/runsRepository/runsRepository.server";
import {
  createRun,
  insertTaskRunV2Rows,
  seedParents,
} from "./helpers/apiRunListPresenterTestHelpers";

vi.mock("~/db.server", () => ({ prisma: {}, $replica: {} }));

vi.setConfig({ testTimeout: 90_000 });

const DAY_MS = 24 * 60 * 60 * 1000;

describe("runs list query shape (PREWHERE routing under FINAL)", () => {
  containerTest(
    "keeps status post-FINAL and returns old pending runs (no date clamp)",
    async ({ clickhouseContainer, prisma }) => {
      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "query-shape-test",
      });

      const ctx = await seedParents(prisma, "shape");

      const completed = await createRun(prisma, ctx, { friendlyId: "run_completed" });
      const pendingRecent = await createRun(prisma, ctx, { friendlyId: "run_pending_recent" });
      const pendingOld = await createRun(prisma, ctx, { friendlyId: "run_pending_old" });

      const base = {
        taskIdentifier: "webhook.deliver",
        runTags: ["booking:T"],
        createdAt: new Date(Date.now() - 1 * DAY_MS),
      };

      await insertTaskRunV2Rows(clickhouse, [
        { ...completed, ...base, status: "PENDING", updatedAt: new Date(Date.now() - 2 * DAY_MS) },
        {
          ...completed,
          ...base,
          status: "COMPLETED",
          updatedAt: new Date(Date.now() - 1 * DAY_MS),
        },
        {
          ...pendingRecent,
          ...base,
          status: "PENDING",
          updatedAt: new Date(Date.now() - 1 * DAY_MS),
        },
        {
          ...pendingOld,
          ...base,
          status: "PENDING",
          createdAt: new Date(Date.now() - 60 * DAY_MS),
          updatedAt: new Date(Date.now() - 60 * DAY_MS),
        },
      ]);

      const repository = new RunsRepository({ prisma, clickhouse });

      const { runIds } = await repository.listRunIds({
        page: { size: 10 },
        period: "365d",
        organizationId: ctx.organizationId,
        projectId: ctx.projectId,
        environmentId: ctx.environmentId,
        tasks: ["webhook.deliver"],
        tags: ["booking:T"],
        statuses: ["PENDING", "DELAYED"],
      });

      expect(runIds.sort()).toEqual([pendingOld.id, pendingRecent.id].sort());
    }
  );
});
