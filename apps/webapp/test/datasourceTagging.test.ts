import { context, propagation, trace } from "@opentelemetry/api";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { makeNShardRunOpsPostgresTest, postgresTest } from "@internal/testcontainers";
import { RunOpsPrismaClient } from "@internal/run-ops-database";
import { PrismaClient } from "@trigger.dev/database";
import { PrismaInstrumentation } from "@prisma/instrumentation";
import { describe, expect } from "vitest";
import {
  DatasourceAttributeSpanProcessor,
  tagDatasource,
  tagDatasourceRunOps,
} from "~/utils/datasourceTagging.server";

function setupTracing() {
  trace.disable();
  context.disable();
  propagation.disable();

  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({
    spanProcessors: [new DatasourceAttributeSpanProcessor(), new SimpleSpanProcessor(exporter)],
  });
  provider.register();
  const unregister = registerInstrumentations({
    tracerProvider: provider,
    instrumentations: [new PrismaInstrumentation()],
  });

  return {
    exporter,
    tracer: provider.getTracer("test-tracer"),
    async shutdown() {
      unregister();
      await provider.shutdown();
      trace.disable();
      context.disable();
      propagation.disable();
    },
  };
}

const runOpsShardTest = makeNShardRunOpsPostgresTest(1);

type Labels = { datasource: unknown; client: unknown };
const labelsOf = (span: ReadableSpan): Labels => ({
  datasource: span.attributes["db.datasource"],
  client: span.attributes["db.client_type"],
});

function expectEveryQuerySpanLabelled(exporter: InMemorySpanExporter, expected: Labels[]) {
  const spans = exporter.getFinishedSpans();
  const parentOf = new Map(spans.map((s) => [s.spanContext().spanId, s.parentSpanContext?.spanId]));
  const isUnder = (span: ReadableSpan, ancestorId: string) => {
    for (let id = parentOf.get(span.spanContext().spanId); id; id = parentOf.get(id)) {
      if (id === ancestorId) return true;
    }
    return false;
  };

  const operations = spans.filter((s) => s.name === "prisma:client:operation");
  expect(operations.map(labelsOf)).toEqual(expected);

  operations.forEach((operation, i) => {
    const below = spans.filter((s) => isUnder(s, operation.spanContext().spanId));
    expect(
      below.some((s) => s.name === "prisma:engine:db_query"),
      `no db_query span under operation ${i}`
    ).toBe(true);
    for (const span of below) {
      expect(labelsOf(span), `${span.name} under operation ${i}`).toEqual(labelsOf(operation));
    }
  });
}

const callerLabels = (exporter: InMemorySpanExporter) =>
  exporter
    .getFinishedSpans()
    .filter((s) => s.name === "caller")
    .map(labelsOf);

describe("datasource tagging", () => {
  postgresTest(
    "tagDatasource: two clients on one datasource are told apart by db.client_type",
    async ({ postgresContainer }) => {
      const tracing = setupTracing();
      const client = new PrismaClient({
        datasources: { db: { url: postgresContainer.getConnectionUri() } },
      });
      try {
        const writer = tagDatasource("control-plane-writer", "control-plane-writer", client);
        const other = tagDatasource("control-plane-writer", "control-plane-writer-2", client);

        await tracing.tracer.startActiveSpan("caller", async (span) => {
          await writer.organization.findFirst();
          await other.organization.findFirst();
          span.end();
        });

        expect(callerLabels(tracing.exporter)).toEqual([
          { datasource: undefined, client: undefined },
        ]);
        expectEveryQuerySpanLabelled(tracing.exporter, [
          { datasource: "control-plane-writer", client: "control-plane-writer" },
          { datasource: "control-plane-writer", client: "control-plane-writer-2" },
        ]);
      } finally {
        await client.$disconnect();
        await tracing.shutdown();
      }
    }
  );

  runOpsShardTest(
    "tagDatasourceRunOps: gen-1 and shard clients share run-ops-writer and are told apart by db.client_type",
    async ({ newUri, shardUris }) => {
      const tracing = setupTracing();
      const gen1Client = new RunOpsPrismaClient({ datasources: { db: { url: newUri } } });
      const shardClient = new RunOpsPrismaClient({ datasources: { db: { url: shardUris[0]! } } });
      try {
        const gen1 = tagDatasourceRunOps("run-ops-writer", "run-ops-writer", gen1Client);
        const shardA = tagDatasourceRunOps("run-ops-writer", "run-ops-shard-a-writer", shardClient);

        await tracing.tracer.startActiveSpan("caller", async (span) => {
          await gen1.taskRun.findFirst();
          await shardA.taskRun.findFirst();
          span.end();
        });

        expect(callerLabels(tracing.exporter)).toEqual([
          { datasource: undefined, client: undefined },
        ]);
        expectEveryQuerySpanLabelled(tracing.exporter, [
          { datasource: "run-ops-writer", client: "run-ops-writer" },
          { datasource: "run-ops-writer", client: "run-ops-shard-a-writer" },
        ]);
      } finally {
        await gen1Client.$disconnect();
        await shardClient.$disconnect();
        await tracing.shutdown();
      }
    }
  );
});
