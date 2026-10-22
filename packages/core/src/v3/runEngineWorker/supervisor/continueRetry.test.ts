import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SupervisorHttpClient } from "./http.js";

const createdAt = "2026-01-01T00:00:00.000Z";
const execution = {
  version: "1",
  snapshot: {
    id: "snapshot_2",
    friendlyId: "snap_2",
    executionStatus: "EXECUTING",
    description: "Run was continued after being suspended",
    createdAt,
  },
  run: { id: "run_1", friendlyId: "run_1", status: "EXECUTING", attemptNumber: 1 },
  completedWaitpoints: [],
};

// Each request takes the next scripted reply: an HTTP status, a dropped connection, or a response
// with headers or a delay. Once the script runs out, the last entry repeats.
type Reply =
  | number
  | "drop"
  | { status: number; delayMs?: number; headers?: Record<string, string> };

// Small delays and no minimum remaining budget, so the tests run in milliseconds.
const fastBackoff = {
  minDelayMs: 5,
  maxDelayMs: 20,
  serverErrorMaxDelayMs: 20,
  minAttemptBudgetMs: 0,
};

describe("SupervisorHttpClient.continueRunExecution retries", () => {
  let server: Server;
  let apiUrl: string;
  let script: Reply[] = [];
  let requests = 0;

  beforeAll(async () => {
    server = createServer((_request, response) => {
      const reply = script[Math.min(requests, script.length - 1)]!;
      requests++;

      if (reply === "drop") {
        response.socket?.destroy();
        return;
      }

      const {
        status,
        delayMs = 0,
        headers = {},
      } = typeof reply === "number" ? { status: reply } : reply;

      setTimeout(() => {
        response.statusCode = status;
        response.setHeader("content-type", "application/json");
        for (const [name, value] of Object.entries(headers)) {
          response.setHeader(name, value);
        }
        response.end(JSON.stringify(status === 200 ? execution : { error: "nope" }));
      }, delayMs);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    requests = 0;
  });

  function continueWithBudget(budget: { budgetMs: number; minAttemptBudgetMs?: number }) {
    return new SupervisorHttpClient({
      apiUrl,
      workerToken: "token",
      instanceName: "test",
    }).continueRunExecution("run_1", "snapshot_1", "runner_1", "env_1", {
      retryBudget: { ...fastBackoff, ...budget },
    });
  }

  it("keeps retrying temporary failures within the budget until it succeeds", async () => {
    script = [503, 409, 429, 502, 504, 408, "drop", 200];

    const result = await continueWithBudget({ budgetMs: 5_000 });

    expect(result.success).toBe(true);
    expect(requests).toBe(8);
    expect(result.retry).toMatchObject({ attempts: 8, outcome: "succeeded" });
  });

  it("gives a plain 500 only the usual number of attempts, even with a budget", async () => {
    script = [500];

    const result = await continueWithBudget({ budgetMs: 5_000 });

    expect(result.success).toBe(false);
    expect(requests).toBe(8);
    expect(result.retry).toMatchObject({ attempts: 8, outcome: "server_errors" });
  });

  it("counts plain 500s separately, so temporary failures in between don't use them up", async () => {
    // 11 attempts, but only 5 of them are plain 500s.
    script = [500, 409, 500, 409, 500, 409, 500, 409, 500, 409, 200];

    const result = await continueWithBudget({ budgetMs: 5_000 });

    expect(result.success).toBe(true);
    expect(requests).toBe(11);
  });

  it("stops at the 8th plain 500 even with temporary failures in between", async () => {
    script = [409, 500, 409, 500, 409, 500, 409, 500, 409, 500, 409, 500, 409, 500, 409, 500, 200];

    const result = await continueWithBudget({ budgetMs: 5_000 });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.statusCode).toBe(500);
    }
    expect(requests).toBe(16);
    expect(result.retry).toMatchObject({ attempts: 16, outcome: "server_errors" });
  });

  it("stops at once on a non-retryable status", async () => {
    script = [409, 422];

    const result = await continueWithBudget({ budgetMs: 5_000 });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.statusCode).toBe(422);
    }
    expect(requests).toBe(2);
    expect(result.retry).toMatchObject({ attempts: 2, outcome: "non_retryable" });
  });

  it("stops at once when the server says not to retry, whatever the status", async () => {
    script = [{ status: 409, headers: { "x-should-retry": "false" } }, 200];

    const result = await continueWithBudget({ budgetMs: 5_000 });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.statusCode).toBe(409);
    }
    expect(requests).toBe(1);
    expect(result.retry).toMatchObject({ attempts: 1, outcome: "non_retryable" });
  });

  it("retries when the server says to, whatever the status", async () => {
    script = [{ status: 400, headers: { "x-should-retry": "true" } }, 200];

    const result = await continueWithBudget({ budgetMs: 5_000 });

    expect(result.success).toBe(true);
    expect(requests).toBe(2);
  });

  it("gives up when the budget runs out", async () => {
    script = [503];
    const start = Date.now();

    const result = await continueWithBudget({ budgetMs: 300 });

    expect(result.success).toBe(false);
    expect(requests).toBeGreaterThan(3);
    expect(Date.now() - start).toBeLessThan(1_000);
    expect(result.retry?.outcome).toBe("budget_exhausted");
  });

  it("doesn't start a retry with less than the minimum budget left", async () => {
    script = [503];

    const result = await continueWithBudget({ budgetMs: 300, minAttemptBudgetMs: 1_000 });

    expect(result.success).toBe(false);
    expect(requests).toBe(1);
    expect(result.retry).toMatchObject({ attempts: 1, outcome: "budget_exhausted" });
  });

  it("cuts off a retry that would run past the budget", async () => {
    script = [503, { status: 200, delayMs: 2_000 }];
    const start = Date.now();

    const result = await continueWithBudget({ budgetMs: 300 });

    expect(result.success).toBe(false);
    expect(requests).toBe(2);
    expect(Date.now() - start).toBeLessThan(1_000);
    expect(result.retry?.outcome).toBe("budget_exhausted");
  });

  it("cuts off the first attempt too, if it would run past the budget", async () => {
    script = [{ status: 200, delayMs: 2_000 }];
    const start = Date.now();

    const result = await continueWithBudget({ budgetMs: 300 });

    expect(result.success).toBe(false);
    expect(requests).toBe(1);
    expect(Date.now() - start).toBeLessThan(1_000);
  });

  it("without a budget, still retries a temporary failure as today", async () => {
    script = [503, 200];

    const result = await new SupervisorHttpClient({
      apiUrl,
      workerToken: "token",
      instanceName: "test",
    }).continueRunExecution("run_1", "snapshot_1", "runner_1", "env_1");

    expect(result.success).toBe(true);
    expect(requests).toBe(2);
    expect(result.retry).toBeUndefined();
  });
});
