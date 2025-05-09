import { clickhouseTest } from "@internal/testcontainers";
import { ClickhouseClient } from "./client.js";
import { z } from "zod";
import { setTimeout } from "timers/promises";

describe("ClickHouse Client", () => {
  clickhouseTest("should be able to insert and query data", async ({ clickhouseContainer }) => {
    const client = new ClickhouseClient({
      name: "test",
      url: clickhouseContainer.getConnectionUrl(),
    });

    const insertSmokeTest = client.insert({
      name: "insert-smoke-test",
      table: "trigger_dev.smoke_test",
      schema: z.object({
        message: z.string(),
        number: z.number(),
      }),
    });

    const querySmokeTest = client.query({
      name: "query-smoke-test",
      query: "SELECT * FROM trigger_dev.smoke_test",
      schema: z.object({
        message: z.string(),
        number: z.number(),
        timestamp: z.string(),
        id: z.string(),
      }),
    });

    const [insertError, insertResult] = await insertSmokeTest([
      { message: "hello", number: 42 },
      { message: "world", number: 100 },
    ]);

    expect(insertError).toBeNull();
    expect(insertResult).toEqual(
      expect.objectContaining({
        executed: true,
        query_id: expect.any(String),
        summary: expect.objectContaining({ read_rows: "2", elapsed_ns: expect.any(String) }),
      })
    );

    const [queryError, result] = await querySmokeTest({});

    expect(queryError).toBeNull();

    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "hello",
          number: 42,
          timestamp: expect.any(String),
          id: expect.any(String),
        }),
        expect.objectContaining({
          message: "world",
          number: 100,
          timestamp: expect.any(String),
          id: expect.any(String),
        }),
      ])
    );

    const insertSmokeTestAsyncWaiting = client.insert({
      name: "insert-smoke-test-async-waiting",
      table: "trigger_dev.smoke_test",
      schema: z.object({
        message: z.string(),
        number: z.number(),
      }),
      settings: {
        async_insert: 1,
        wait_for_async_insert: 1,
        async_insert_busy_timeout_ms: 1000,
      },
    });

    const [insertErrorAsyncWaiting, insertResultAsyncWaiting] = await insertSmokeTestAsyncWaiting([
      { message: "async-waiting-hello", number: 42 },
      { message: "async-waiting-world", number: 100 },
    ]);

    expect(insertErrorAsyncWaiting).toBeNull();
    expect(insertResultAsyncWaiting).toEqual(expect.objectContaining({ executed: true }));

    // Should be able to query for the data right away
    const [queryErrorAsyncWaiting, resultAsyncWaiting] = await querySmokeTest({});

    expect(queryErrorAsyncWaiting).toBeNull();
    expect(resultAsyncWaiting).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: "async-waiting-hello", number: 42 }),
        expect.objectContaining({ message: "async-waiting-world", number: 100 }),
      ])
    );

    const insertSmokeTestAsyncDontWait = client.insert({
      name: "insert-smoke-test-async-dont-wait",
      table: "trigger_dev.smoke_test",
      schema: z.object({
        message: z.string(),
        number: z.number(),
      }),
      settings: {
        async_insert: 1,
        wait_for_async_insert: 0,
        async_insert_busy_timeout_ms: 1000,
      },
    });

    const [insertErrorAsyncDontWait, insertResultAsyncDontWait] =
      await insertSmokeTestAsyncDontWait([
        { message: "async-dont-wait-hello", number: 42 },
        { message: "async-dont-wait-world", number: 100 },
      ]);

    expect(insertErrorAsyncDontWait).toBeNull();
    expect(insertResultAsyncDontWait).toEqual(expect.objectContaining({ executed: true }));

    // Querying now should return an array without the data
    const [queryErrorAsyncDontWait, resultAsyncDontWait] = await querySmokeTest({});

    expect(queryErrorAsyncDontWait).toBeNull();
    expect(resultAsyncDontWait).toEqual(
      expect.not.arrayContaining([
        expect.objectContaining({ message: "async-dont-wait-hello", number: 42 }),
        expect.objectContaining({ message: "async-dont-wait-world", number: 100 }),
      ])
    );

    // Now we wait for the data to be flushed
    await setTimeout(2000);

    // Querying now should return the data
    const [queryErrorAsyncDontWait2, resultAsyncDontWait2] = await querySmokeTest({});

    expect(queryErrorAsyncDontWait2).toBeNull();
    expect(resultAsyncDontWait2).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: "async-dont-wait-hello", number: 42 }),
        expect.objectContaining({ message: "async-dont-wait-world", number: 100 }),
      ])
    );
  });
});
