import { ClickHouseError } from "@clickhouse/client";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ClickhouseClient, isRetryableConnectionError } from "./client.js";

/**
 * Unit tests for the connection-retry behaviour of read queries. These tests do
 * NOT require a live ClickHouse server: the underlying `@clickhouse/client`
 * query method is lazy (it does not connect at construction time), so we spy on
 * `client.client.query` and simulate transient connection errors.
 */

function connectionResetError(message = "read ECONNRESET", code = "ECONNRESET") {
  return Object.assign(new Error(message), { code });
}

function fakeResultSet(rows: Array<Record<string, unknown>>) {
  return {
    query_id: "test-query-id",
    response_headers: {} as Record<string, string>,
    json: async () => rows,
  } as any;
}

function newClient(overrides?: Partial<ConstructorParameters<typeof ClickhouseClient>[0]>) {
  return new ClickhouseClient({
    name: "test",
    url: "http://localhost:8123",
    // Zero delays so retry tests run instantly.
    connectionRetry: { maxAttempts: 3, minDelayMs: 0, maxDelayMs: 0 },
    logLevel: "error",
    ...overrides,
  });
}

const schema = z.object({ value: z.number() });

describe("ClickhouseClient read retries", () => {
  it("retries a read that fails once with ECONNRESET and then succeeds", async () => {
    const client = newClient();

    let calls = 0;
    const spy = vi.spyOn(client.client, "query").mockImplementation((async () => {
      calls++;
      if (calls === 1) {
        throw connectionResetError();
      }
      return fakeResultSet([{ value: 42 }]);
    }) as any);

    const runQuery = client.query({
      name: "retry-once",
      query: "SELECT 42 AS value",
      schema,
    });

    const [error, result] = await runQuery({});

    expect(error).toBeNull();
    expect(result).toEqual([{ value: 42 }]);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("gives up after the configured number of attempts on repeated connection resets", async () => {
    const client = newClient({ connectionRetry: { maxAttempts: 3, minDelayMs: 0, maxDelayMs: 0 } });

    const spy = vi.spyOn(client.client, "query").mockImplementation((async () => {
      throw connectionResetError();
    }) as any);

    const runQuery = client.query({
      name: "always-reset",
      query: "SELECT 1 AS value",
      schema,
    });

    const [error, result] = await runQuery({});

    expect(result).toBeNull();
    expect(error).not.toBeNull();
    expect(error?.name).toBe("QueryError");
    expect(error?.message).toContain("ECONNRESET");
    // maxAttempts total (1 initial + 2 retries)
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry a server-side ClickHouseError (e.g. SQL error)", async () => {
    const client = newClient();

    const spy = vi.spyOn(client.client, "query").mockImplementation((async () => {
      throw new ClickHouseError({
        code: "62",
        type: "SYNTAX_ERROR",
        message: "Syntax error near 'SELCT'",
      });
    }) as any);

    const runQuery = client.query({
      name: "sql-error",
      query: "SELCT 1",
      schema,
    });

    const [error, result] = await runQuery({});

    expect(result).toBeNull();
    expect(error?.name).toBe("QueryError");
    // Server errors must fail immediately, without retrying.
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry a generic non-connection error", async () => {
    const client = newClient();

    const spy = vi.spyOn(client.client, "query").mockImplementation((async () => {
      throw new Error("something unrelated went wrong");
    }) as any);

    const runQuery = client.query({
      name: "generic-error",
      query: "SELECT 1 AS value",
      schema,
    });

    const [error, result] = await runQuery({});

    expect(result).toBeNull();
    expect(error?.name).toBe("QueryError");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("retries queryWithStats and queryFast on connection resets", async () => {
    // queryWithStats
    const statsClient = newClient();
    let statsCalls = 0;
    vi.spyOn(statsClient.client, "query").mockImplementation((async () => {
      statsCalls++;
      if (statsCalls === 1) throw connectionResetError("socket hang up", undefined as any);
      return fakeResultSet([{ value: 7 }]);
    }) as any);

    const runWithStats = statsClient.queryWithStats({
      name: "stats-retry",
      query: "SELECT 7 AS value",
      schema,
    });
    const [statsError, statsResult] = await runWithStats({});
    expect(statsError).toBeNull();
    expect(statsResult?.rows).toEqual([{ value: 7 }]);
    expect(statsCalls).toBe(2);

    // queryFast
    const fastClient = newClient();
    let fastCalls = 0;
    vi.spyOn(fastClient.client, "query").mockImplementation((async () => {
      fastCalls++;
      if (fastCalls === 1) throw connectionResetError();
      return {
        query_id: "fast-id",
        response_headers: {},
        stream: async function* () {
          yield [{ json: () => [99] }];
        },
      } as any;
    }) as any);

    const runFast = fastClient.queryFast<{ value: number }, {}>({
      name: "fast-retry",
      query: "SELECT 99 AS value",
      columns: ["value"],
    });
    const [fastError, fastResult] = await runFast({});
    expect(fastError).toBeNull();
    expect(fastResult).toEqual([{ value: 99 }]);
    expect(fastCalls).toBe(2);
  });
});

describe("isRetryableConnectionError", () => {
  it("classifies ECONNRESET (by code) as retryable", () => {
    expect(isRetryableConnectionError(connectionResetError("read ECONNRESET", "ECONNRESET"))).toBe(
      true
    );
  });

  it("classifies EPIPE (by code) as retryable", () => {
    expect(isRetryableConnectionError(connectionResetError("write EPIPE", "EPIPE"))).toBe(true);
  });

  it("classifies ETIMEDOUT (by code) as retryable", () => {
    expect(isRetryableConnectionError(connectionResetError("timeout", "ETIMEDOUT"))).toBe(true);
  });

  it("classifies 'socket hang up' message (no code) as retryable", () => {
    expect(isRetryableConnectionError(new Error("socket hang up"))).toBe(true);
  });

  it("classifies an ECONNRESET substring in the message as retryable", () => {
    expect(
      isRetryableConnectionError(new Error("Unable to query clickhouse: read ECONNRESET"))
    ).toBe(true);
  });

  it("classifies a wrapped connection error (via cause) as retryable", () => {
    const wrapped = new Error("outer failure");
    (wrapped as any).cause = connectionResetError();
    expect(isRetryableConnectionError(wrapped)).toBe(true);
  });

  it("does NOT classify a server-side ClickHouseError as retryable", () => {
    const chError = new ClickHouseError({
      code: "241",
      type: "MEMORY_LIMIT_EXCEEDED",
      message: "Memory limit exceeded",
    });
    expect(isRetryableConnectionError(chError)).toBe(false);
  });

  it("does NOT classify a generic error as retryable", () => {
    expect(isRetryableConnectionError(new Error("something unrelated"))).toBe(false);
  });
});
