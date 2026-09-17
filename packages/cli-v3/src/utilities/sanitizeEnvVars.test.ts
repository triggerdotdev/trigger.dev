import { describe, expect, test } from "vitest";
import { buildDevRunEnv, sanitizeEnvVars } from "./sanitizeEnvVars.js";

describe("sanitizeEnvVars", () => {
  test("drops empty, whitespace-only, and undefined local values", () => {
    expect(sanitizeEnvVars({ SET: "x", EMPTY: "", WHITESPACE: "   ", MISSING: undefined })).toEqual(
      { SET: "x" }
    );
  });
});

describe("buildDevRunEnv", () => {
  test("fresh project values override machine defaults, while local overrides win", () => {
    const env = buildDevRunEnv({
      resolvedEnvVars: { EMPTY: "", WHITESPACE: "   ", FILE_OVERRIDE: "server" },
      processEnv: { EMPTY: "machine", FILE_OVERRIDE: "machine", LOCAL: "local" },
      envOverrides: { FILE_OVERRIDE: "file", TRIGGER_PROJECT_REF: "wrong-project" },
      projectRef: "proj_123",
    });
    expect(env).toEqual({
      EMPTY: "",
      WHITESPACE: "   ",
      FILE_OVERRIDE: "file",
      LOCAL: "local",
      TRIGGER_PROJECT_REF: "proj_123",
    });
  });

  test("handles an absent server response", () => {
    expect(
      buildDevRunEnv({
        resolvedEnvVars: undefined,
        processEnv: { LOCAL: "x" },
        envOverrides: {},
        projectRef: "proj_123",
      })
    ).toEqual({ LOCAL: "x", TRIGGER_PROJECT_REF: "proj_123" });
  });
});
