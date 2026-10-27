// A run stored as "clickhouse" (legacy v1) writes to and reads from task_events_v2 once the
// reroute is on, through the same factory path OTLP ingest and the trace readers use.
import { ClickHouse } from "@internal/clickhouse";
import { containerTestWithClickhouse } from "@internal/testcontainers";
import { SemanticInternalAttributes } from "@trigger.dev/core/v3";
import { ExportTraceServiceRequest, ResourceSpans, Span } from "@trigger.dev/otlp-importer";
import { describe, expect, vi } from "vitest";
import { z } from "zod";
import { ClickhouseConnectionSchema } from "~/services/clickhouse/clickhouseSecretSchemas.server";
import { ClickhouseFactory } from "~/services/clickhouse/clickhouseFactory.server";
import { OrganizationDataStoresRegistry } from "~/services/dataStores/organizationDataStoresRegistry.server";
import type { ClickhouseEventRepository } from "~/v3/eventRepository/clickhouseEventRepository.server";
import type { CreateEventInput } from "~/v3/eventRepository/eventRepository.types";
import { OTLPExporter } from "~/v3/otlpExporter.server";

vi.setConfig({ testTimeout: 120_000 });

const ORG_ID = "org_v1_reroute";
const ENV_ID = "env_v1_reroute";
const TRACE_ID = "f".repeat(32);
const RUN_ID = "run_v1_reroute";

function span(spanId: string, parentId: string | undefined, message: string): CreateEventInput {
  return {
    message,
    traceId: TRACE_ID,
    spanId,
    parentId,
    startTime: BigInt(Date.now()) * 1_000_000n,
    duration: 1_000_000,
    isPartial: false,
    environmentId: ENV_ID,
    environmentType: "PRODUCTION",
    organizationId: ORG_ID,
    projectId: "project_v1_reroute",
    runId: RUN_ID,
    taskSlug: "reroute-task",
    properties: {},
    metadata: undefined,
    style: undefined,
  };
}

async function shutdown(repository: ClickhouseEventRepository) {
  await Promise.all([
    (repository as any)._flushScheduler.shutdown(),
    (repository as any)._llmMetricsFlushScheduler.shutdown(),
    (repository as any)._otlpMetricsFlushScheduler.shutdown(),
  ]);
}

async function countRows(clickhouse: ClickHouse, table: string, runId = RUN_ID): Promise<number> {
  const query = clickhouse.reader.query({
    name: "count-reroute-rows",
    query: `SELECT count() AS c FROM trigger_dev.${table} WHERE run_id = {runId: String}`,
    params: z.object({ runId: z.string() }),
    schema: z.object({ c: z.coerce.number() }),
  });
  const [error, rows] = await query({ runId });
  if (error) throw error;
  return rows[0]?.c ?? 0;
}

// OTLP spans as an SDK sends them for a run, tagged with the run's store.
function otlpSpans(store: string, runId: string, spanByte: number): ResourceSpans {
  const now = BigInt(Date.now()) * 1_000_000n;
  return ResourceSpans.fromPartial({
    resource: {
      attributes: [
        { key: SemanticInternalAttributes.TRIGGER, value: { boolValue: true } },
        { key: SemanticInternalAttributes.TASK_EVENT_STORE, value: { stringValue: store } },
        { key: SemanticInternalAttributes.ORGANIZATION_ID, value: { stringValue: ORG_ID } },
        { key: SemanticInternalAttributes.ENVIRONMENT_ID, value: { stringValue: ENV_ID } },
        { key: SemanticInternalAttributes.RUN_ID, value: { stringValue: runId } },
      ],
    },
    scopeSpans: [
      {
        spans: [
          Span.fromPartial({
            traceId: Buffer.alloc(16, spanByte),
            spanId: Buffer.alloc(8, spanByte),
            name: `span from ${store}`,
            startTimeUnixNano: now,
            endTimeUnixNano: now + 1_000n,
          }),
        ],
      },
    ],
  });
}

describe("v1 event store reroute", () => {
  containerTestWithClickhouse(
    "writes and reads a clickhouse-stored run through task_events_v2",
    async ({ prisma, clickhouseContainer }) => {
      const url = clickhouseContainer.getConnectionUrl();
      const registry = new OrganizationDataStoresRegistry(prisma, prisma);
      await registry.addDataStore({
        key: "reroute-integration",
        kind: "CLICKHOUSE",
        organizationIds: [ORG_ID],
        config: ClickhouseConnectionSchema.parse({ url }),
      });
      await registry.loadFromDatabase();

      const factory = new ClickhouseFactory(registry, true);
      const { repository } = factory.getEventRepositoryForOrganizationSync("clickhouse", ORG_ID);
      const writer = repository as ClickhouseEventRepository;

      writer.insertMany([
        span("a".repeat(16), undefined, "root"),
        span("b".repeat(16), "a".repeat(16), "child"),
      ]);
      await shutdown(writer);

      const clickhouse = new ClickHouse({ url, name: "reroute-test", logLevel: "error" });
      await vi.waitFor(async () => expect(await countRows(clickhouse, "task_events_v2")).toBe(2), {
        timeout: 15_000,
        interval: 250,
      });
      expect(await countRows(clickhouse, "task_events_v1")).toBe(0);

      const { repository: reader } = factory.getEventRepositoryForOrganizationSync(
        "clickhouse",
        ORG_ID
      );
      const startCreatedAt = new Date(Date.now() - 60 * 60 * 1000);

      const summary = await reader.getTraceSummary("taskEvent", ENV_ID, TRACE_ID, startCreatedAt);
      expect(summary?.spans.map((s) => s.data.message).sort()).toEqual(["child", "root"]);

      const spanDetail = await reader.getSpan(
        "taskEvent",
        ENV_ID,
        "b".repeat(16),
        TRACE_ID,
        startCreatedAt
      );
      expect(spanDetail?.message).toBe("child");
    }
  );
  containerTestWithClickhouse(
    "keeps a clickhouse-stored run on task_events_v1 when the reroute is off",
    async ({ prisma, clickhouseContainer }) => {
      const url = clickhouseContainer.getConnectionUrl();
      const registry = new OrganizationDataStoresRegistry(prisma, prisma);
      await registry.addDataStore({
        key: "reroute-integration-off",
        kind: "CLICKHOUSE",
        organizationIds: [ORG_ID],
        config: ClickhouseConnectionSchema.parse({ url }),
      });
      await registry.loadFromDatabase();

      const factory = new ClickhouseFactory(registry, false);
      const { repository } = factory.getEventRepositoryForOrganizationSync("clickhouse", ORG_ID);
      const writer = repository as ClickhouseEventRepository;

      writer.insertMany([span("a".repeat(16), undefined, "root")]);
      await shutdown(writer);

      const clickhouse = new ClickHouse({ url, name: "reroute-test-off", logLevel: "error" });
      await vi.waitFor(async () => expect(await countRows(clickhouse, "task_events_v1")).toBe(1), {
        timeout: 15_000,
        interval: 250,
      });
      expect(await countRows(clickhouse, "task_events_v2")).toBe(0);
    }
  );
  containerTestWithClickhouse(
    "writes OTLP telemetry tagged clickhouse to task_events_v2",
    async ({ prisma, clickhouseContainer }) => {
      const url = clickhouseContainer.getConnectionUrl();
      const registry = new OrganizationDataStoresRegistry(prisma, prisma);
      await registry.addDataStore({
        key: "reroute-integration-otlp",
        kind: "CLICKHOUSE",
        organizationIds: [ORG_ID],
        config: ClickhouseConnectionSchema.parse({ url }),
      });
      await registry.loadFromDatabase();

      const factory = new ClickhouseFactory(registry, true);
      const exporter = new OTLPExporter({
        clickhouseFactory: factory,
        verbose: false,
        spanAttributeValueLengthLimit: 8192,
      });

      await exporter.exportTraces(
        ExportTraceServiceRequest.fromPartial({
          resourceSpans: [
            otlpSpans("clickhouse", "run_otlp_v1", 1),
            otlpSpans("clickhouse_v2", "run_otlp_v2", 2),
          ],
        })
      );

      const { repository } = factory.getEventRepositoryForOrganizationSync("clickhouse_v2", ORG_ID);
      await shutdown(repository as ClickhouseEventRepository);

      const clickhouse = new ClickHouse({ url, name: "reroute-test-otlp", logLevel: "error" });
      await vi.waitFor(
        async () => {
          expect(await countRows(clickhouse, "task_events_v2", "run_otlp_v1")).toBeGreaterThan(0);
          expect(await countRows(clickhouse, "task_events_v2", "run_otlp_v2")).toBeGreaterThan(0);
        },
        { timeout: 15_000, interval: 250 }
      );
      expect(await countRows(clickhouse, "task_events_v1", "run_otlp_v1")).toBe(0);
    }
  );
});
