// Keyed waitpoint creation that runs out of its time budget under load used to reach the
// boundary as a 500. These tests pin the retryable status the create routes now answer with.
import { describe, expect, it } from "vitest";
import { WaitpointKeyTransactionBudgetExhaustedError } from "@internal/run-store";
import { keyedWaitpointBudgetResponse } from "~/services/routeBuilders/keyedWaitpointBudget.server";

describe("keyedWaitpointBudgetResponse", () => {
  // Catches: an over-budget keyed waitpoint creation answering 500 without x-should-retry.
  it("answers a retryable 503 when keyed waitpoint creation is over budget", async () => {
    const response = keyedWaitpointBudgetResponse(
      new WaitpointKeyTransactionBudgetExhaustedError(),
      {}
    );

    expect(response).toBeDefined();
    expect(response!.status).toBe(503);
    expect(response!.headers.get("x-should-retry")).toBe("true");
    await expect(response!.json()).resolves.toEqual({
      error: "Waitpoint creation is busy, please retry",
    });
  });

  // Catches: unrelated failures, including a plain Error with the same message, turning into a 503.
  it("declines an unrelated error so it still reaches the 500 path", () => {
    expect(
      keyedWaitpointBudgetResponse(
        new Error("Keyed waitpoint creation transaction budget exhausted"),
        {}
      )
    ).toBeUndefined();
    expect(keyedWaitpointBudgetResponse(undefined, {})).toBeUndefined();
  });
});
