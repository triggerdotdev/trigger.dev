import { ClickHouse, setQueryObserver } from "@internal/clickhouse";
import { clickhouseTest } from "@internal/testcontainers";
import { metrics } from "@opentelemetry/api";
import type { DataPoint, Histogram } from "@opentelemetry/sdk-metrics";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createInMemoryMetrics } from "./utils/tracing";

import type * as RequestFeature from "~/services/requestFeature.server";

let requestFeatureModule: typeof RequestFeature;
let telemetry: ReturnType<typeof createInMemoryMetrics>;

beforeAll(async () => {
  telemetry = createInMemoryMetrics();
  metrics.disable();
  metrics.setGlobalMeterProvider(telemetry.meterProvider);
  delete (globalThis as { __trigger_singletons?: Record<string, unknown> }).__trigger_singletons
    ?.requestFeatureTelemetry;
  requestFeatureModule = await import("~/services/requestFeature.server");
  setQueryObserver(requestFeatureModule.requestFeatureQueryObserver);
});

afterAll(async () => {
  setQueryObserver(undefined);
  await telemetry?.shutdown();
  metrics.disable();
});

function countQuery(client: ClickHouse, rows: number) {
  return client.reader.query({
    name: "count-numbers",
    query: `SELECT count() AS c FROM numbers(${rows})`,
    schema: z.object({ c: z.coerce.number() }),
  })({});
}

async function dataPoints(metricName: string): Promise<DataPoint<unknown>[]> {
  const exported = await telemetry.getMetrics();
  const latest = exported.at(-1);
  return (
    latest?.scopeMetrics
      .flatMap((scope) => scope.metrics)
      .filter((metric) => metric.descriptor.name === metricName)
      .flatMap((metric) => metric.dataPoints as DataPoint<unknown>[]) ?? []
  );
}

describe("withRequestFeature", () => {
  // Catches: concurrent requests adding their ClickHouse rows to each other's totals.
  clickhouseTest(
    "keeps separate ClickHouse totals for concurrent requests",
    async ({ clickhouseContainer }) => {
      const { withRequestFeature, requestFeature } = requestFeatureModule;
      const client = new ClickHouse({
        name: "test",
        url: clickhouseContainer.getConnectionUrl(),
      });

      const small = withRequestFeature("session.trace", async () => {
        requestFeature.describe({ kind: "first", serverTiming: true, readContext: "session" });
        await countQuery(client, 1_000);
        return new Response("ok");
      });
      const big = withRequestFeature("session.trace", async () => {
        requestFeature.describe({ kind: "page", serverTiming: true, readContext: "session" });
        await Promise.all([countQuery(client, 5_000), countQuery(client, 5_000)]);
        return new Response("ok");
      });
      const [smallResponse, bigResponse] = await Promise.all([small, big]);

      expect(smallResponse.headers.get("Server-Timing")).toMatch(/desc="1000 rows"/);
      expect(bigResponse.headers.get("Server-Timing")).toMatch(/desc="10000 rows"/);

      await client.close();
    }
  );

  // Catches: feature labels missing from the duration or ClickHouse metrics the monitors read.
  clickhouseTest(
    "labels the request duration and the ClickHouse metrics",
    async ({ clickhouseContainer }) => {
      const { withRequestFeature, requestFeature } = requestFeatureModule;
      const client = new ClickHouse({
        name: "labelled",
        url: clickhouseContainer.getConnectionUrl(),
      });

      await withRequestFeature("session.trace", async () => {
        requestFeature.describe({ kind: "poll", viewer: "admin", readContext: "session" });
        await countQuery(client, 100);
        return new Response("ok", { status: 404 });
      });

      const durations = await dataPoints("feature_request.duration");
      expect(durations.map((point) => point.attributes)).toContainEqual({
        feature: "session.trace",
        kind: "poll",
        status_class: "4xx",
        viewer: "admin",
      });

      const readRows = (await dataPoints("clickhouse.query.read_rows")).filter(
        (point) => point.attributes.client === "labelled"
      );
      expect(readRows).toHaveLength(1);
      expect(readRows[0]?.attributes).toMatchObject({
        feature: "session.trace",
        read_context: "session",
      });
      const histogram = readRows[0]?.value as Histogram | undefined;
      expect(histogram?.sum).toBe(100);

      await client.close();
    }
  );

  // Catches: thrown 404s recorded as 5xx, which would trip the 5xx monitor.
  it("records a thrown Response's status", async () => {
    const { withRequestFeature, requestFeature } = requestFeatureModule;

    await expect(
      withRequestFeature("run.trace", async () => {
        requestFeature.describe({ kind: "tail", viewer: "member" });
        throw new Response("Not found", { status: 404 });
      })
    ).rejects.toBeInstanceOf(Response);

    const durations = await dataPoints("feature_request.duration");
    expect(durations.map((point) => point.attributes)).toContainEqual({
      feature: "run.trace",
      kind: "tail",
      status_class: "4xx",
      viewer: "member",
    });
  });

  // Catches: every other route's ClickHouse metrics gaining labels or a header.
  clickhouseTest(
    "records nothing new for a request without a feature",
    async ({ clickhouseContainer }) => {
      const { withRequestFeature } = requestFeatureModule;
      const client = new ClickHouse({
        name: "unlabelled",
        url: clickhouseContainer.getConnectionUrl(),
      });

      const response = await withRequestFeature(undefined, async () => {
        await countQuery(client, 100);
        return new Response("ok");
      });

      expect(response.headers.get("Server-Timing")).toBeNull();
      const readRows = (await dataPoints("clickhouse.query.read_rows")).filter(
        (point) => point.attributes.client === "unlabelled"
      );
      expect(readRows).toHaveLength(1);
      expect(readRows[0]?.attributes).toEqual({ client: "unlabelled", operation: "count-numbers" });

      await client.close();
    }
  );

  // Catches: run page chunk responses gaining the header meant for session reads.
  clickhouseTest("adds no Server-Timing header unless asked", async ({ clickhouseContainer }) => {
    const { withRequestFeature } = requestFeatureModule;
    const client = new ClickHouse({
      name: "no-header",
      url: clickhouseContainer.getConnectionUrl(),
    });

    const response = await withRequestFeature("run.trace", async () => {
      await countQuery(client, 100);
      return new Response("ok");
    });

    expect(response.headers.get("Server-Timing")).toBeNull();

    await client.close();
  });
});
