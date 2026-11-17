import { describe, expect, it } from "vitest";
import { resolvePolicyScopes, sandboxExecutionPolicy } from "./executionPolicy.js";

describe("sandbox execution policy scopes", () => {
  // Catches: placeholders minted literally, or session scopes granted to a run without a Session.
  it("fills in the run and drops session scopes when there is no session", () => {
    const { scopes } = sandboxExecutionPolicy({});

    expect(resolvePolicyScopes(scopes, { runId: "run_a", sessionId: "session_b" })).toEqual([
      "read:runs:run_a",
      "write:runs:run_a",
      "read:sessions:session_b:in",
      "write:sessions:session_b:out",
      "write:oidc",
    ]);
    expect(resolvePolicyScopes(scopes, { runId: "run_a" })).toEqual([
      "read:runs:run_a",
      "write:runs:run_a",
      "write:oidc",
    ]);
  });
});
