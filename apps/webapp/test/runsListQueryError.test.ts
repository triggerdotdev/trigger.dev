import { ClickHouse } from "@internal/clickhouse";
import { containerTest } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";
import {
  RunsListQueryError,
  RunsRepository,
} from "~/services/runsRepository/runsRepository.server";
import {
  createRun,
  insertTaskRunV2Rows,
  seedParents,
} from "./helpers/apiRunListPresenterTestHelpers";

vi.mock("~/db.server", () => ({ prisma: {}, $replica: {} }));

vi.setConfig({ testTimeout: 90_000 });

describe("runs list query error handling", () => {
  containerTest(
    "a ClickHouse resource-limit error surfaces as RunsListQueryError",
    async ({ clickhouseContainer, prisma }) => {
      const ctx = await seedParents(prisma, "qerr");
      const run = await createRun(prisma, ctx, { friendlyId: "run_qerr" });

      const seedClient = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "runs-list-query-error-seed",
      });
      await insertTaskRunV2Rows(seedClient, [{ ...run, createdAt: new Date() }]);

      const listArgs = {
        page: { size: 10 } as const,
        organizationId: ctx.organizationId,
        projectId: ctx.projectId,
        environmentId: ctx.environmentId,
      };

      const cappedClient = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "runs-list-query-error-capped",
        clickhouseSettings: { max_memory_usage: "1" },
      });
      const capped = new RunsRepository({ prisma, clickhouse: cappedClient });
      await expect(capped.listRuns(listArgs)).rejects.toBeInstanceOf(RunsListQueryError);
      await expect(capped.countRuns(listArgs)).rejects.toBeInstanceOf(RunsListQueryError);

      const ok = new RunsRepository({ prisma, clickhouse: seedClient });
      const result = await ok.listRuns(listArgs);
      expect(result.runs.map((r) => r.friendlyId)).toEqual(["run_qerr"]);
    }
  );
});
