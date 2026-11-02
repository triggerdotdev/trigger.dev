import { describe, expect, it } from "vitest";
import { dropInheritedRunToken, installRunToken } from "./runTokenEnv.js";

const attempt = (runId: string, number: number) => ({ run: { id: runId }, attempt: { number } });

describe("installRunToken", () => {
  it("only replaces the token of the attempt it was minted for", () => {
    const env: NodeJS.ProcessEnv = { TRIGGER_RUN_TOKEN: "current" };
    const update = { runId: "run_a", attemptNumber: 1, token: "refreshed" };

    expect(installRunToken(attempt("run_b", 1), update, env)).toBe(false);
    expect(installRunToken(attempt("run_a", 2), update, env)).toBe(false);
    expect(installRunToken(undefined, update, env)).toBe(false);
    expect(env.TRIGGER_RUN_TOKEN).toBe("current");

    expect(installRunToken(attempt("run_a", 1), update, env)).toBe(true);
    expect(env.TRIGGER_RUN_TOKEN).toBe("refreshed");
  });
});

describe("dropInheritedRunToken", () => {
  it("removes a previous run's token when the next attempt has none", () => {
    const env: NodeJS.ProcessEnv = { TRIGGER_RUN_TOKEN: "previous-run" };

    dropInheritedRunToken({ TRIGGER_SECRET_KEY: "tr_prod" }, env);

    expect(env.TRIGGER_RUN_TOKEN).toBeUndefined();
  });
});
