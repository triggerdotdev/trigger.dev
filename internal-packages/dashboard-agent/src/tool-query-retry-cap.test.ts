import { describe, expect, it, vi } from "vitest";
import { buildApiTools, MAX_CONSECUTIVE_QUERY_FAILURES } from "./tool-api";
import type { DashboardAgentApiClient } from "./tool-api-client";

/**
 * A failed query hands the model the database error to fix. Without a cap, the only other
 * limit is the turn's step budget, so a model that keeps rewriting the same broken query
 * burns the whole turn and the user gets no answer. After three failures in a row the tool
 * tells it to stop and answer.
 */

function queryTool(postQuery: DashboardAgentApiClient["postQuery"]) {
  const client = {
    origin: "https://api.example.com",
    hasAuth: true,
    envApiGet: async () => ({ ok: false as const, status: 500 }),
    postQuery,
    validateChartQuery: async () => null,
  } as unknown as DashboardAgentApiClient;
  const tools = buildApiTools({
    ctx: { userActorToken: "uat", apiOrigin: client.origin },
    client,
    renderInvestigations: (() => []) as any,
  });
  return (query: string) => (tools.run_query as any).execute({ query }, {} as any);
}

const failure = {
  ok: false as const,
  kind: "query" as const,
  error: "Unknown expression identifier 'createdAt'.",
};
const transportFailure = {
  ok: false as const,
  kind: "transport" as const,
  error: "The environment is temporarily unavailable.",
};
const busyFailure = {
  ok: false as const,
  kind: "busy" as const,
  error: "We're experiencing a lot of queries at the moment. You can retry the same query shortly.",
};
const success = { ok: true as const, rows: [{ n: 1 }] };

describe("run_query's consecutive-failure cap", () => {
  it("keeps handing back the plain error until the cap", async () => {
    const run = queryTool(async () => failure);

    for (let attempt = 1; attempt < MAX_CONSECUTIVE_QUERY_FAILURES; attempt++) {
      const result = await run("SELECT createdAt FROM runs");
      expect(result.error).toBe(failure.error);
    }
  });

  it("tells the model to stop and answer at the cap", async () => {
    const run = queryTool(async () => failure);

    let result: { error: string } = { error: "" };
    for (let attempt = 0; attempt < MAX_CONSECUTIVE_QUERY_FAILURES; attempt++) {
      result = await run("SELECT createdAt FROM runs");
    }

    expect(result.error).toContain(failure.error);
    expect(result.error).toContain("answer the user with what you already have");
  });

  it("counts consecutive failures only, so a good query clears the count", async () => {
    const postQuery = vi
      .fn()
      .mockResolvedValueOnce(failure)
      .mockResolvedValueOnce(failure)
      .mockResolvedValueOnce(success)
      .mockResolvedValue(failure);
    const run = queryTool(postQuery as any);

    await run("bad");
    await run("bad");
    await run("good");
    const result = await run("bad");

    expect(result.error).toBe(failure.error);
  });

  it("does not count transport errors toward the cap", async () => {
    const run = queryTool(async () => transportFailure);

    let result: { error: string } = { error: "" };
    for (let attempt = 0; attempt < MAX_CONSECUTIVE_QUERY_FAILURES + 2; attempt++) {
      result = await run("SELECT createdAt FROM runs");
    }

    expect(result.error).toBe(transportFailure.error);
    expect(result.error).not.toContain("answer the user with what you already have");
  });

  // A "too busy" rejection says nothing about the query, so spending the cap on it would
  // stop the model over a queue that clears in seconds.
  it("does not count busy rejections toward the cap", async () => {
    const run = queryTool(async () => busyFailure);

    let result: { error: string } = { error: "" };
    for (let attempt = 0; attempt < MAX_CONSECUTIVE_QUERY_FAILURES + 2; attempt++) {
      result = await run("SELECT createdAt FROM runs");
    }

    expect(result.error).toBe(busyFailure.error);
    expect(result.error).not.toContain("answer the user with what you already have");
  });

  it("still caps real SQL errors that follow busy rejections", async () => {
    const postQuery = vi.fn().mockResolvedValueOnce(busyFailure).mockResolvedValue(failure);
    const run = queryTool(postQuery as any);

    await run("busy");
    let result: { error: string } = { error: "" };
    for (let attempt = 0; attempt < MAX_CONSECUTIVE_QUERY_FAILURES; attempt++) {
      result = await run("SELECT createdAt FROM runs");
    }

    expect(result.error).toContain("answer the user with what you already have");
  });
});
