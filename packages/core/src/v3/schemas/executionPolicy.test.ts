import { describe, expect, it } from "vitest";
import { resolvePolicyScopes, sandboxExecutionPolicy } from "./executionPolicy.js";

describe("sandbox execution policy scopes", () => {
  it.each([undefined, "session_b"])("only grants own-run I/O with session %s", (sessionId) => {
    const { scopes } = sandboxExecutionPolicy({});
    expect(resolvePolicyScopes(scopes, { runId: "run_a", sessionId })).toEqual([
      "read:runPayloads:run_a",
      "write:runOutputs:run_a",
    ]);
  });

  it("resolves additional scopes without granting a session to an unbound run", () => {
    const { scopes } = sandboxExecutionPolicy({
      scopes: ["read:sessions:$session:in", "write:oidc", "read:runs:$run"],
    });

    expect(resolvePolicyScopes(scopes, { runId: "run_a", sessionId: "session_b" })).toEqual([
      "read:runPayloads:run_a",
      "write:runOutputs:run_a",
      "read:sessions:session_b:in",
      "write:oidc",
      "read:runs:run_a",
    ]);
    expect(resolvePolicyScopes(scopes, { runId: "run_a" })).toEqual([
      "read:runPayloads:run_a",
      "write:runOutputs:run_a",
      "write:oidc",
      "read:runs:run_a",
    ]);
  });
});
