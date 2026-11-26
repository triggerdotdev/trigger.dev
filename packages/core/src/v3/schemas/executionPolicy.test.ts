import { describe, expect, it } from "vitest";
import {
  isNetworkAllowHost,
  resolvePolicyScopes,
  restrictedNetwork,
  type RunExecutionPolicy,
  sandboxExecutionPolicy,
} from "./executionPolicy.js";

describe("sandbox network policy", () => {
  // Catches: a sandbox defaulting to the open internet, or a policy that lost its network field
  // being treated as unrestricted.
  it("restricts by default and fails closed on a missing field", () => {
    expect(restrictedNetwork(sandboxExecutionPolicy({}))).toEqual({ allow: [] });
    expect(restrictedNetwork(sandboxExecutionPolicy({ network: "restricted" }))).toEqual({
      allow: [],
    });
    expect(restrictedNetwork(sandboxExecutionPolicy({ network: "unrestricted" }))).toBeUndefined();
    const withoutNetwork: RunExecutionPolicy = {
      ...sandboxExecutionPolicy({}),
      network: undefined,
    };
    expect(restrictedNetwork(withoutNetwork)).toEqual({ allow: [] });
    expect(restrictedNetwork(undefined)).toBeUndefined();
  });

  // Catches: allow entries that open far more than one domain, or reach an IP directly.
  it("accepts only hostnames and single-domain wildcards", () => {
    for (const host of ["api.github.com", "*.github.com", "registry.npmjs.org"]) {
      expect(isNetworkAllowHost(host), host).toBe(true);
    }
    for (const host of ["*", "*.com", "com", "1.2.3.4", "API.github.com", "a.*.com", "x_y.com"]) {
      expect(isNetworkAllowHost(host), host).toBe(false);
    }
  });
});

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
