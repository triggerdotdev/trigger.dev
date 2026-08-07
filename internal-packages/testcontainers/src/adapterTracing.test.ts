import { registerInstrumentations } from "@opentelemetry/instrumentation";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { PrismaInstrumentation } from "@prisma/instrumentation";
import { expect } from "vitest";
import { postgresTest } from "./index";
import { createAdapterClient, createRustClient } from "./adapterGolden";

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
provider.register();
registerInstrumentations({
  tracerProvider: provider,
  instrumentations: [new PrismaInstrumentation()],
});

async function collectSpanNames(query: () => Promise<unknown>): Promise<string[]> {
  exporter.reset();
  await query();
  await provider.forceFlush();
  return exporter
    .getFinishedSpans()
    .map((s: ReadableSpan) => s.name)
    .sort();
}

postgresTest(
  "Deliverable A — engine spans survive the adapter",
  async ({ postgresContainer }) => {
    const url = postgresContainer.getConnectionUri();
    const rust = createRustClient(url);
    const adapter = createAdapterClient(url);

    try {
      const rustSpans = await collectSpanNames(
        () => rust.$queryRaw`SELECT 1 AS one, 'x'::text AS label`
      );
      const adapterSpans = await collectSpanNames(
        () => adapter.$queryRaw`SELECT 1 AS one, 'x'::text AS label`
      );

      const unique = (xs: string[]) => Array.from(new Set(xs)).sort();

      console.log("[TRI-13039][A] rust engine span names:   ", unique(rustSpans));
      console.log("[TRI-13039][A] adapter    span names:   ", unique(adapterSpans));
      console.log(
        "[TRI-13039][A] prisma:engine:connection present under adapter:",
        adapterSpans.includes("prisma:engine:connection")
      );

      expect(rustSpans, "baseline: rust engine emits engine spans").toContain(
        "prisma:engine:db_query"
      );

      expect(adapterSpans, "GATE: client operation span present under adapter").toContain(
        "prisma:client:operation"
      );
      expect(adapterSpans, "GATE: engine db_query span present under adapter").toContain(
        "prisma:engine:db_query"
      );
    } finally {
      await Promise.allSettled([rust.$disconnect(), adapter.$disconnect()]);
    }
  },
  120000
);
