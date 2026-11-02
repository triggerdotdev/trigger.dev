import { clickhouseTest } from "@internal/testcontainers";
import { z } from "zod";
import { ClickhouseClient } from "./client.js";
import { setQueryObserver, type QueryObservation } from "./queryObserver.js";

describe("query observer", () => {
  afterEach(() => setQueryObserver(undefined));

  // Catches: the observer not called, or called without the rows read.
  clickhouseTest("reports each query's rows and labels", async ({ clickhouseContainer }) => {
    const client = new ClickhouseClient({
      name: "test",
      url: clickhouseContainer.getConnectionUrl(),
    });
    const observations: QueryObservation[] = [];
    let labelCalls = 0;
    setQueryObserver({
      metricAttributes: () => {
        labelCalls++;
        return { feature: "session.trace" };
      },
      onQuery: (observation) => observations.push(observation),
    });

    const query = client.query({
      name: "count-numbers",
      query: "SELECT count() AS c FROM numbers(5000)",
      schema: z.object({ c: z.coerce.number() }),
    });
    const [error, rows] = await query({});

    expect(error).toBeNull();
    expect(rows?.[0]?.c).toBe(5000);
    expect(labelCalls).toBe(1);
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ client: "test", operation: "count-numbers" });
    expect(observations[0]?.readRows).toBe(5000);
    expect(observations[0]?.errorType).toBeUndefined();

    await client.close();
  });

  // Catches: failed queries missing from the per-request totals.
  clickhouseTest(
    "reports failed queries with their error type",
    async ({ clickhouseContainer }) => {
      const client = new ClickhouseClient({
        name: "test",
        url: clickhouseContainer.getConnectionUrl(),
      });
      const observations: QueryObservation[] = [];
      setQueryObserver({ onQuery: (observation) => observations.push(observation) });

      const query = client.query({
        name: "missing-table",
        query: "SELECT * FROM table_that_does_not_exist",
        schema: z.any(),
      });
      const [error] = await query({});

      expect(error).not.toBeNull();
      expect(observations).toHaveLength(1);
      expect(observations[0]?.errorType).toBeDefined();

      await client.close();
    }
  );

  // Catches: queries breaking in processes that never set an observer.
  clickhouseTest("queries work with no observer set", async ({ clickhouseContainer }) => {
    const client = new ClickhouseClient({
      name: "test",
      url: clickhouseContainer.getConnectionUrl(),
    });

    const query = client.query({
      name: "one",
      query: "SELECT 1 AS one",
      schema: z.object({ one: z.coerce.number() }),
    });
    const [error, rows] = await query({});

    expect(error).toBeNull();
    expect(rows?.[0]?.one).toBe(1);

    await client.close();
  });
});
