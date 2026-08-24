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

describe("runs list created_at clamp", () => {
  containerTest(
    "listRuns is capped to the window; countRuns and the unclamped instance are not",
    async ({ clickhouseContainer, prisma }) => {
      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "created-at-clamp-test",
      });

      const ctx = await seedParents(prisma, "clamp");

      const recent = await createRun(prisma, ctx, { friendlyId: "run_recent", status: "PENDING" });
      const old = await createRun(prisma, ctx, { friendlyId: "run_old", status: "PENDING" });

      await insertTaskRunV2Rows(clickhouse, [
        { ...recent, createdAt: new Date(Date.now() - 1 * DAY_MS) },
        { ...old, createdAt: new Date(Date.now() - 60 * DAY_MS) },
      ]);

      const listArgs = {
        page: { size: 10 },
        period: "365d",
        organizationId: ctx.organizationId,
        projectId: ctx.projectId,
        environmentId: ctx.environmentId,
      };
      const countArgs = {
        period: "365d",
        organizationId: ctx.organizationId,
        projectId: ctx.projectId,
        environmentId: ctx.environmentId,
      };

      const clamped = new RunsRepository({ prisma, clickhouse, maxCreatedAtAgeMs: 30 * DAY_MS });
      const clampedList = await clamped.listRuns(listArgs);
      expect(clampedList.runs.map((r) => r.friendlyId)).toEqual(["run_recent"]);

      const unclamped = new RunsRepository({ prisma, clickhouse });
      const unclampedList = await unclamped.listRuns(listArgs);
      expect(unclampedList.runs.map((r) => r.friendlyId).sort()).toEqual(["run_old", "run_recent"]);

      expect(await clamped.countRuns(countArgs)).toBe(2);
    }
  );
});
