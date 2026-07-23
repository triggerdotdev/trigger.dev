import { ClickHouse, type TaskEventV2Input } from "@internal/clickhouse";
import { clickhouseTest } from "@internal/testcontainers";
import { describe, expect } from "vitest";
import { z } from "zod";
import {
  ClickhouseEventRepository,
  convertDateToClickhouseDateTime,
} from "~/v3/eventRepository/clickhouseEventRepository.server";

const TIMEOUT_MS = 60_000;

function deeplyNested(depth: number): Record<string, unknown> {
  let node: Record<string, unknown> = { leaf: 1 };
  for (let i = 0; i < depth; i++) {
    node = { [`k${i}`]: node };
  }
  return node;
}

function startTime(baseMs: number, offsetMs: number): string {
  const ns = ((BigInt(baseMs) + BigInt(offsetMs)) * 1_000_000n).toString();
  return `${ns.substring(0, 10)}.${ns.substring(10)}`;
}

describe("ClickhouseEventRepository JSON parse recovery", () => {
  clickhouseTest(
    "lands the good events when one event in the batch has ClickHouse-unparseable attributes",
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

      const environmentId = "env_json_recovery_test";
      const organizationId = "org_json_recovery_test";
      const projectId = "proj_json_recovery_test";
      const traceId = "b".repeat(32);
      const baseMs = Date.now();
      const expiresAt = convertDateToClickhouseDateTime(
        new Date(baseMs + 365 * 24 * 60 * 60 * 1000)
      );

      function makeRow(i: number, attributes: unknown): TaskEventV2Input {
        return {
          environment_id: environmentId,
          organization_id: organizationId,
          project_id: projectId,
          task_identifier: "json-recovery-task",
          run_id: `run_${i}`,
          start_time: startTime(baseMs, i),
          duration: "1000000",
          trace_id: traceId,
          span_id: `span_recovery_${String(i).padStart(6, "0")}`,
          parent_span_id: "",
          message: `event ${i}`,
          kind: "SPAN",
          status: "OK",
          attributes,
          metadata: "{}",
          expires_at: expiresAt,
        };
      }

      const goodSpanIds: string[] = [];
      let poisonSpanId = "";
      const rows: TaskEventV2Input[] = [];
      for (let i = 0; i < 5; i++) {
        const isPoison = i === 2;
        const row = makeRow(i, isPoison ? deeplyNested(1500) : { ok: true, i });
        rows.push(row);
        if (isPoison) {
          poisonSpanId = row.span_id;
        } else {
          goodSpanIds.push(row.span_id);
        }
      }

      try {
        (repository as any).addToBatch(rows);

        const queryEvents = clickhouse.reader.query({
          name: "event-recovery-check",
          query:
            "SELECT span_id FROM trigger_dev.task_events_v2 WHERE environment_id = {env_id:String}",
          schema: z.object({ span_id: z.string() }),
          params: z.object({ env_id: z.string() }),
        });

        const landedIds = await vi.waitFor(
          async () => {
            const [queryError, resultRows] = await queryEvents({ env_id: environmentId });
            expect(queryError).toBeNull();
            const ids = new Set((resultRows ?? []).map((r) => r.span_id));
            for (const id of goodSpanIds) {
              expect(ids.has(id)).toBe(true);
            }
            return ids;
          },
          { timeout: 30_000, interval: 250 }
        );

        for (const id of goodSpanIds) {
          expect(landedIds.has(id)).toBe(true);
        }
        expect(landedIds.has(poisonSpanId)).toBe(false);

        expect(repository.permanentlyDroppedBatches).toBe(0);
        expect(repository.rowIsolationRecoveries).toBeGreaterThanOrEqual(1);
      } finally {
        await (repository as any)._flushScheduler?.shutdown?.();
      }
    },
    TIMEOUT_MS
  );
});
