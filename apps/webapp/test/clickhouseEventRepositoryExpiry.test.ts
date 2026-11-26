import { ClickHouse } from "@internal/clickhouse";
import { clickhouseTest } from "@internal/testcontainers";
import type { TaskEventEnvironment } from "@trigger.dev/core/v3";
import { describe, expect, vi } from "vitest";
import { z } from "zod";
import { ClickhouseEventRepository } from "~/v3/eventRepository/clickhouseEventRepository.server";
import type {
  CompleteableTaskRun,
  CreateEventInput,
} from "~/v3/eventRepository/eventRepository.types";

const DAY_MS = 24 * 60 * 60 * 1000;
const TOLERANCE_MS = 60_000;
const ORG_ID = "org_event_expiry";
const PROJECT_ID = "proj_event_expiry";
const TASK = "event-expiry-task";

const COMPLETION_RUN_IDS = [
  "run_expiry_success",
  "run_expiry_cached",
  "run_expiry_failed",
  "run_expiry_expired",
  "run_expiry_attempt_failed",
  "run_expiry_cancelled",
];
const WRITE_PATH_RUN_IDS = ["run_expiry_insert", "run_expiry_record", "run_expiry_trace"];

function environment(envId: string): TaskEventEnvironment {
  return {
    id: envId,
    type: "PRODUCTION",
    organizationId: ORG_ID,
    projectId: PROJECT_ID,
    project: { externalRef: "proj_event_expiry_ref" },
  };
}

function span(envId: string): CreateEventInput {
  return {
    message: "ingested span",
    traceId: "d".repeat(32),
    spanId: "aaaaaaaaaaaaaaaa",
    startTime: BigInt(Date.now()) * 1_000_000n,
    duration: 1_000_000,
    isPartial: false,
    environmentId: envId,
    environmentType: "PRODUCTION",
    organizationId: ORG_ID,
    projectId: PROJECT_ID,
    runId: "run_expiry_insert",
    taskSlug: TASK,
    properties: {},
    metadata: undefined,
    style: undefined,
    events: [{ name: "exception", time: new Date(Date.now() + 10), properties: {} }],
  };
}

function oldRun(envId: string, friendlyId: string): CompleteableTaskRun {
  return {
    friendlyId,
    traceId: "e".repeat(32),
    spanId: "bbbbbbbbbbbbbbbb",
    parentSpanId: null,
    createdAt: new Date(Date.now() - 40 * DAY_MS),
    completedAt: null,
    taskIdentifier: TASK,
    projectId: PROJECT_ID,
    runtimeEnvironmentId: envId,
    organizationId: ORG_ID,
    isTest: false,
  };
}

async function writeThroughEveryPath(repository: ClickhouseEventRepository, envId: string) {
  repository.insertMany([span(envId)]);

  await repository.recordEvent("recorded event", {
    environment: environment(envId),
    taskSlug: TASK,
    attributes: { runId: "run_expiry_record" },
  });

  await repository.traceEvent(
    "traced operation",
    { environment: environment(envId), taskSlug: TASK, attributes: { runId: "run_expiry_trace" } },
    async (event) => {
      event.failWithError({
        type: "BUILT_IN_ERROR",
        name: "Error",
        message: "boom",
        stackTrace: "",
      });
    }
  );

  const [success, cached, failed, expired, attemptFailed, cancelled] = COMPLETION_RUN_IDS.map(
    (id) => oldRun(envId, id)
  );
  const exception = { message: "boom", type: "Error" };

  await repository.completeSuccessfulRunEvent({ run: success });
  await repository.completeCachedRunEvent({
    run: cached,
    blockedRun: cached,
    spanId: "cccccccccccccccc",
    parentSpanId: "bbbbbbbbbbbbbbbb",
    spanCreatedAt: cached.createdAt,
    isError: false,
  });
  await repository.completeFailedRunEvent({ run: failed, exception });
  await repository.completeExpiredRunEvent({ run: expired, ttl: "1h" });
  await repository.createAttemptFailedRunEvent({ run: attemptFailed, attemptNumber: 1, exception });
  await repository.cancelRunEvent({ run: cancelled, reason: "cancelled", cancelledAt: new Date() });
}

async function shutdownRepository(repository: ClickhouseEventRepository) {
  await Promise.all([
    (repository as any)._flushScheduler.shutdown(),
    (repository as any)._llmMetricsFlushScheduler.shutdown(),
    (repository as any)._otlpMetricsFlushScheduler.shutdown(),
  ]);
}

async function readExpiries(clickhouse: ClickHouse, envId: string) {
  const query = clickhouse.reader.query({
    name: "event-expiry-check",
    query: `SELECT run_id,
        toUnixTimestamp64Milli(expires_at) AS expires_ms,
        toUnixTimestamp64Milli(inserted_at) AS inserted_ms
      FROM trigger_dev.task_events_v2
      WHERE environment_id = {envId: String}`,
    params: z.object({ envId: z.string() }),
    schema: z.object({
      run_id: z.string(),
      expires_ms: z.coerce.number(),
      inserted_ms: z.coerce.number(),
    }),
  });

  const [error, rows] = await query({ envId });
  expect(error).toBeNull();
  return rows!;
}

async function expectEveryRowExpiresAfter(
  clickhouse: ClickHouse,
  envId: string,
  retentionDays: number
) {
  const rows = await vi.waitFor(
    async () => {
      const result = await readExpiries(clickhouse, envId);
      expect(new Set(result.map((r) => r.run_id))).toEqual(
        new Set([...WRITE_PATH_RUN_IDS, ...COMPLETION_RUN_IDS])
      );
      return result;
    },
    { timeout: 30_000, interval: 250 }
  );
  for (const row of rows) {
    expect(
      Math.abs(row.expires_ms - (row.inserted_ms + retentionDays * DAY_MS)),
      `${row.run_id} expiry`
    ).toBeLessThan(TOLERANCE_MS);
  }
}

describe("ClickhouseEventRepository expires_at", () => {
  clickhouseTest(
    "every write path expires 30 days after writing by default, including completions of old runs",
    async ({ clickhouseContainer }) => {
      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        logLevel: "error",
      });
      const repository = new ClickhouseEventRepository({
        clickhouse,
        version: "v2",
        insertStrategy: "insert",
        flushInterval: 50,
      });

      try {
        await writeThroughEveryPath(repository, "env_expiry_default");
        await expectEveryRowExpiresAfter(clickhouse, "env_expiry_default", 30);
      } finally {
        await shutdownRepository(repository);
      }
    },
    60_000
  );

  clickhouseTest(
    "uses the configured retention",
    async ({ clickhouseContainer }) => {
      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        logLevel: "error",
      });
      const repository = new ClickhouseEventRepository({
        clickhouse,
        version: "v2",
        insertStrategy: "insert",
        flushInterval: 50,
        retentionDays: 365,
      });

      try {
        await writeThroughEveryPath(repository, "env_expiry_configured");
        await expectEveryRowExpiresAfter(clickhouse, "env_expiry_configured", 365);
      } finally {
        await shutdownRepository(repository);
      }
    },
    60_000
  );
});
