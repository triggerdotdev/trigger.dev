import { ClickHouse } from "@internal/clickhouse";
import { clickhouseTest } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";
import { z } from "zod";
import { ClickhouseEventRepository } from "~/v3/eventRepository/clickhouseEventRepository.server";
import type { CreateEventInput } from "~/v3/eventRepository/eventRepository.types";

const ENV_ID = "env_malformed_span_events";
const RUN_ID = "run_malformed_span_events";

function span(spanId: string, events?: CreateEventInput["events"]): CreateEventInput {
  const startMs = Date.now();
  return {
    message: `span ${spanId}`,
    traceId: "c".repeat(32),
    spanId,
    startTime: BigInt(startMs) * 1_000_000n,
    duration: 1_000_000,
    isPartial: false,
    environmentId: ENV_ID,
    environmentType: "PRODUCTION",
    organizationId: "org_malformed_span_events",
    projectId: "proj_malformed_span_events",
    runId: RUN_ID,
    taskSlug: "malformed-span-events-task",
    properties: {},
    metadata: undefined,
    style: undefined,
    events,
  };
}

describe("ClickhouseEventRepository span events", () => {
  clickhouseTest(
    "stores exception and attempt_failed span events without exception attributes instead of failing the batch, keeping attempt_failed as an override",
    async ({ clickhouseContainer }) => {
      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        logLevel: "error",
      });

      const repository = new ClickhouseEventRepository({
        clickhouse,
        version: "v2",
        insertStrategy: "insert",
        batchSize: 100,
        flushInterval: 200,
      });

      const eventTime = new Date(Date.now() + 10);

      try {
        expect(() =>
          repository.insertMany([
            span("aaaaaaaaaaaaaaaa", [
              { name: "exception", time: eventTime, properties: {} },
              {
                name: "attempt_failed",
                time: eventTime,
                properties: { attemptNumber: 1, runId: RUN_ID },
              },
            ]),
            span("bbbbbbbbbbbbbbbb"),
          ])
        ).not.toThrow();

        const queryRows = clickhouse.reader.query({
          name: "malformed-span-events-check",
          query:
            "SELECT span_id, kind, message FROM trigger_dev.task_events_v2 WHERE run_id = {runId: String}",
          schema: z.object({ span_id: z.string(), kind: z.string(), message: z.string() }),
          params: z.object({ runId: z.string() }),
        });

        const rows = await vi.waitFor(
          async () => {
            const [error, result] = await queryRows({ runId: RUN_ID });
            expect(error).toBeNull();
            expect(result).toHaveLength(4);
            return result!;
          },
          { timeout: 30_000, interval: 250 }
        );

        const kindByMessage = Object.fromEntries(rows.map((r) => [r.message, r.kind]));
        expect(kindByMessage.exception).toBe("SPAN_EVENT");
        expect(kindByMessage.attempt_failed).toBe("ANCESTOR_OVERRIDE");
      } finally {
        await Promise.all([
          (repository as any)._flushScheduler.shutdown(),
          (repository as any)._llmMetricsFlushScheduler.shutdown(),
          (repository as any)._otlpMetricsFlushScheduler.shutdown(),
        ]);
      }
    },
    60_000
  );
});
