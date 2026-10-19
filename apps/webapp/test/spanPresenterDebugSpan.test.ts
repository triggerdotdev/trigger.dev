import { describe, expect, vi } from "vitest";

// Wiring overrides only, as in SpanPresenter.readthrough.test.ts: the presenter is given its
// Postgres client through the constructor, and the run store and event repository singletons are
// swapped for instances over the test containers. Every read runs against a real database.
vi.mock("~/db.server", () => ({
  prisma: {},
  $replica: {},
}));

const wiring = vi.hoisted(() => ({
  runStore: undefined as unknown,
  eventRepository: undefined as unknown,
}));
vi.mock("~/v3/runStore.server", () => ({
  get runStore() {
    return wiring.runStore;
  },
}));
vi.mock("~/v3/eventRepository/index.server", () => ({
  getEventRepositoryForStore: async () => wiring.eventRepository,
}));

import { ClickHouse } from "@internal/clickhouse";
import { PostgresRunStore } from "@internal/run-store";
import { containerTestWithClickhouse } from "@internal/testcontainers";
import { SpanPresenter } from "~/presenters/v3/SpanPresenter.server";
import {
  ClickhouseEventRepository,
  convertDateToClickhouseDateTime,
} from "~/v3/eventRepository/clickhouseEventRepository.server";

vi.setConfig({ testTimeout: 90_000 });

function clickhouseDate(value: Date) {
  return value.toISOString().replace("T", " ").replace("Z", "");
}

describe("SpanPresenter debug spans", () => {
  containerTestWithClickhouse(
    "opens a debug span only when debug events are shown",
    async ({ prisma, clickhouseContainer }) => {
      const user = await prisma.user.create({
        data: { email: "span-debug@example.com", authenticationMethod: "MAGIC_LINK" },
      });
      const organization = await prisma.organization.create({
        data: { title: "span-debug", slug: "span-debug" },
      });
      await prisma.orgMember.create({
        data: { organizationId: organization.id, userId: user.id, role: "MEMBER" },
      });
      const project = await prisma.project.create({
        data: {
          name: "span-debug",
          slug: "span-debug",
          organizationId: organization.id,
          externalRef: "proj_span_debug",
        },
      });
      const environment = await prisma.runtimeEnvironment.create({
        data: {
          slug: "prod",
          type: "PRODUCTION",
          projectId: project.id,
          organizationId: organization.id,
          apiKey: "tr_prod_span_debug",
          pkApiKey: "pk_prod_span_debug",
          shortcode: "sc-span-debug",
        },
      });

      const traceId = "d".repeat(32);
      const createdAt = new Date(Date.now() - 60_000);
      await prisma.taskRun.create({
        data: {
          friendlyId: "run_span_debug",
          taskIdentifier: "my-task",
          status: "COMPLETED_SUCCESSFULLY",
          payload: "{}",
          payloadType: "application/json",
          traceId,
          spanId: "rootspan00000001",
          queue: "task/my-task",
          runtimeEnvironmentId: environment.id,
          projectId: project.id,
          organizationId: organization.id,
          environmentType: "PRODUCTION",
          engine: "V2",
          taskEventStore: "clickhouse_v2",
          createdAt,
          completedAt: new Date(createdAt.getTime() + 10_000),
        },
      });

      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "test",
      });
      const repository = new ClickhouseEventRepository({
        clickhouse,
        version: "v2",
        insertStrategy: "insert",
      });
      const startTime = new Date(createdAt.getTime() + 1_000);
      const [insertError] = await clickhouse.taskEventsV2.insert([
        {
          environment_id: environment.id,
          organization_id: organization.id,
          project_id: project.id,
          task_identifier: "my-task",
          run_id: "run_span_debug",
          start_time: `${clickhouseDate(startTime).slice(0, 19)}.${String(
            startTime.getUTCMilliseconds() * 1_000_000
          ).padStart(9, "0")}`,
          inserted_at: convertDateToClickhouseDateTime(startTime),
          duration: "0",
          trace_id: traceId,
          span_id: "debugspan0000001",
          parent_span_id: "rootspan00000001",
          message: "debug event",
          kind: "DEBUG_EVENT",
          status: "OK",
          attributes: {},
          metadata: "{}",
          expires_at: clickhouseDate(new Date(Date.now() + 86_400_000)),
        },
      ]);
      expect(insertError).toBeNull();

      wiring.runStore = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      wiring.eventRepository = repository;

      const presenter = new SpanPresenter(prisma, prisma);
      const call = (showDebug?: boolean) =>
        presenter.call({
          userId: user.id,
          projectSlug: project.slug,
          envSlug: environment.slug,
          spanId: "debugspan0000001",
          runFriendlyId: "run_span_debug",
          showDebug,
        });

      try {
        await expect(call()).rejects.toThrow("Span not found");
        await expect(call(false)).rejects.toThrow("Span not found");
        expect(await call(true)).toMatchObject({
          type: "span",
          span: { spanId: "debugspan0000001" },
        });
      } finally {
        await Promise.all([
          (repository as any)._flushScheduler.shutdown(),
          (repository as any)._llmMetricsFlushScheduler.shutdown(),
          (repository as any)._otlpMetricsFlushScheduler.shutdown(),
        ]);
      }
    }
  );
});
