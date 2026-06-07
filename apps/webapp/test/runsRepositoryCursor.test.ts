import { describe, expect, vi } from "vitest";

// Mock the db prisma client
vi.mock("~/db.server", () => ({
  prisma: {},
  $replica: {},
}));

import { replicationContainerTest } from "@internal/testcontainers";
import { setTimeout } from "node:timers/promises";
import { RunsRepository } from "~/services/runsRepository/runsRepository.server";
import { setupClickhouseReplication } from "./utils/replicationUtils";

vi.setConfig({ testTimeout: 60_000 });

/**
 * Regression tests for keyset pagination over `(created_at, run_id)`.
 *
 * `listRunIds`/`listRuns` order by the composite key `(created_at, run_id)` but
 * the old cursor predicate cut on `run_id` alone. That is only sound when
 * `run_id` lexicographic order matches `created_at` order. When a burst of runs
 * is created such that the two orders diverge (here: deliberately reversed),
 * keyset pagination both re-includes already-seen runs (duplicates) and drops
 * runs it should have returned (skips).
 *
 * Each test inserts runs with explicit ids so that `run_id` ascending order is
 * the exact reverse of `created_at` ascending order, then walks every page and
 * asserts the union is exactly the inserted set with no duplicates.
 */
describe("RunsRepository cursor pagination", () => {
  replicationContainerTest(
    "forward pagination returns every run exactly once when run_id order is the reverse of created_at order",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      const { clickhouse } = await setupClickhouseReplication({
        prisma,
        databaseUrl: postgresContainer.getConnectionUri(),
        clickhouseUrl: clickhouseContainer.getConnectionUrl(),
        redisOptions,
      });

      const organization = await prisma.organization.create({
        data: { title: "test", slug: "test" },
      });
      const project = await prisma.project.create({
        data: {
          name: "test",
          slug: "test",
          organizationId: organization.id,
          externalRef: "test",
        },
      });
      const runtimeEnvironment = await prisma.runtimeEnvironment.create({
        data: {
          slug: "test",
          type: "DEVELOPMENT",
          projectId: project.id,
          organizationId: organization.id,
          apiKey: "test",
          pkApiKey: "test",
          shortcode: "test",
        },
      });

      // run_id ascending: a < b < c < d < e
      // created_at ascending: e < d < c < b < a  (the exact reverse)
      const ids = [
        "aaaaaaaaaaaaaaaaaaaaaaaa",
        "bbbbbbbbbbbbbbbbbbbbbbbb",
        "cccccccccccccccccccccccc",
        "dddddddddddddddddddddddd",
        "eeeeeeeeeeeeeeeeeeeeeeee",
      ];
      const base = new Date("2026-06-04T16:55:07.000Z").getTime();
      for (let i = 0; i < ids.length; i++) {
        await prisma.taskRun.create({
          data: {
            id: ids[i],
            // earliest-created run has the largest run_id (reverse correlation)
            createdAt: new Date(base + (ids.length - 1 - i) * 1000),
            friendlyId: `run_${ids[i]}`,
            taskIdentifier: "my-task",
            payload: JSON.stringify({ foo: "bar" }),
            traceId: `trace_${i}`,
            spanId: `span_${i}`,
            queue: "test",
            runtimeEnvironmentId: runtimeEnvironment.id,
            projectId: project.id,
            organizationId: organization.id,
            environmentType: "DEVELOPMENT",
            engine: "V2",
          },
        });
      }

      await setTimeout(1000);

      const runsRepository = new RunsRepository({ prisma, clickhouse });

      const baseOptions = {
        projectId: project.id,
        environmentId: runtimeEnvironment.id,
        organizationId: organization.id,
      };

      // Walk every forward page, size 2, accumulating ids.
      const seen: string[] = [];
      let cursor: string | undefined = undefined;
      for (let guard = 0; guard < 20; guard++) {
        const page = await runsRepository.listRuns({
          ...baseOptions,
          page: { size: 2, cursor, direction: cursor ? "forward" : undefined },
        });
        seen.push(...page.runs.map((r) => r.id));
        if (!page.pagination.nextCursor) break;
        cursor = page.pagination.nextCursor;
      }

      // No duplicates, no skips: every inserted run appears exactly once.
      expect(seen.slice().sort()).toEqual(ids.slice().sort());
      expect(new Set(seen).size).toBe(ids.length);
    }
  );

  replicationContainerTest(
    "backward pagination round-trips to the previous page when run_id order is the reverse of created_at order",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      const { clickhouse } = await setupClickhouseReplication({
        prisma,
        databaseUrl: postgresContainer.getConnectionUri(),
        clickhouseUrl: clickhouseContainer.getConnectionUrl(),
        redisOptions,
      });

      const organization = await prisma.organization.create({
        data: { title: "test", slug: "test" },
      });
      const project = await prisma.project.create({
        data: {
          name: "test",
          slug: "test",
          organizationId: organization.id,
          externalRef: "test",
        },
      });
      const runtimeEnvironment = await prisma.runtimeEnvironment.create({
        data: {
          slug: "test",
          type: "DEVELOPMENT",
          projectId: project.id,
          organizationId: organization.id,
          apiKey: "test",
          pkApiKey: "test",
          shortcode: "test",
        },
      });

      // run_id ascending: a < b < c ; created_at ascending: c < b < a (reversed).
      const ids = [
        "aaaaaaaaaaaaaaaaaaaaaaaa",
        "bbbbbbbbbbbbbbbbbbbbbbbb",
        "cccccccccccccccccccccccc",
      ];
      const base = new Date("2026-06-04T16:55:07.000Z").getTime();
      for (let i = 0; i < ids.length; i++) {
        await prisma.taskRun.create({
          data: {
            id: ids[i],
            createdAt: new Date(base + (ids.length - 1 - i) * 1000),
            friendlyId: `run_${ids[i]}`,
            taskIdentifier: "my-task",
            payload: JSON.stringify({ foo: "bar" }),
            traceId: `trace_${i}`,
            spanId: `span_${i}`,
            queue: "test",
            runtimeEnvironmentId: runtimeEnvironment.id,
            projectId: project.id,
            organizationId: organization.id,
            environmentType: "DEVELOPMENT",
            engine: "V2",
          },
        });
      }

      await setTimeout(1000);

      const runsRepository = new RunsRepository({ prisma, clickhouse });
      const baseOptions = {
        projectId: project.id,
        environmentId: runtimeEnvironment.id,
        organizationId: organization.id,
      };

      // Forward order (created_at DESC) is [a, b, c]. First page (size 2) = {a, b}.
      const firstPage = await runsRepository.listRuns({
        ...baseOptions,
        page: { size: 2 },
      });
      const firstIds = firstPage.runs.map((r) => r.id).sort();
      expect(firstIds).toEqual(["aaaaaaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbbbbbb"]);
      expect(firstPage.pagination.nextCursor).toBeTruthy();

      // Forward to the second page = {c}; it exposes a previousCursor.
      const secondPage = await runsRepository.listRuns({
        ...baseOptions,
        page: { size: 2, cursor: firstPage.pagination.nextCursor!, direction: "forward" },
      });
      expect(secondPage.runs.map((r) => r.id)).toEqual(["cccccccccccccccccccccccc"]);
      expect(secondPage.pagination.previousCursor).toBeTruthy();

      // Stepping backward from the second page must land back on the first page
      // exactly — no duplicated or skipped runs across the boundary.
      const backPage = await runsRepository.listRuns({
        ...baseOptions,
        page: { size: 2, cursor: secondPage.pagination.previousCursor!, direction: "backward" },
      });
      expect(backPage.runs.map((r) => r.id).sort()).toEqual(firstIds);
    }
  );

  replicationContainerTest(
    "legacy bare run_id cursor still uses the old (run_id-only) predicate for backwards compatibility",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      const { clickhouse } = await setupClickhouseReplication({
        prisma,
        databaseUrl: postgresContainer.getConnectionUri(),
        clickhouseUrl: clickhouseContainer.getConnectionUrl(),
        redisOptions,
      });

      const organization = await prisma.organization.create({
        data: { title: "test", slug: "test" },
      });
      const project = await prisma.project.create({
        data: {
          name: "test",
          slug: "test",
          organizationId: organization.id,
          externalRef: "test",
        },
      });
      const runtimeEnvironment = await prisma.runtimeEnvironment.create({
        data: {
          slug: "test",
          type: "DEVELOPMENT",
          projectId: project.id,
          organizationId: organization.id,
          apiKey: "test",
          pkApiKey: "test",
          shortcode: "test",
        },
      });

      const ids = [
        "aaaaaaaaaaaaaaaaaaaaaaaa",
        "bbbbbbbbbbbbbbbbbbbbbbbb",
        "cccccccccccccccccccccccc",
      ];
      const base = new Date("2026-06-04T16:55:07.000Z").getTime();
      for (let i = 0; i < ids.length; i++) {
        await prisma.taskRun.create({
          data: {
            id: ids[i],
            createdAt: new Date(base + i * 1000),
            friendlyId: `run_${ids[i]}`,
            taskIdentifier: "my-task",
            payload: JSON.stringify({ foo: "bar" }),
            traceId: `trace_${i}`,
            spanId: `span_${i}`,
            queue: "test",
            runtimeEnvironmentId: runtimeEnvironment.id,
            projectId: project.id,
            organizationId: organization.id,
            environmentType: "DEVELOPMENT",
            engine: "V2",
          },
        });
      }

      await setTimeout(1000);

      const runsRepository = new RunsRepository({ prisma, clickhouse });

      // A legacy cursor is a bare run_id. The old predicate is `run_id < cursor`,
      // so passing the largest run_id must return the two smaller ones.
      const page = await runsRepository.listRuns({
        projectId: project.id,
        environmentId: runtimeEnvironment.id,
        organizationId: organization.id,
        page: { size: 10, cursor: "cccccccccccccccccccccccc", direction: "forward" },
      });

      const returned = page.runs.map((r) => r.id).sort();
      expect(returned).toEqual([
        "aaaaaaaaaaaaaaaaaaaaaaaa",
        "bbbbbbbbbbbbbbbbbbbbbbbb",
      ]);
    }
  );
});
