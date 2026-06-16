import { describe, it, expect } from "vitest";
import type { EnvironmentVariable } from "../app/v3/environmentVariables/repository";
import {
  isBlacklistedVariable,
  isReservedForExternalSync,
  removeBlacklistedVariables,
} from "~/v3/environmentVariableRules.server";

describe("removeBlacklistedVariables", () => {
  it("should remove exact match blacklisted variables", () => {
    const variables: EnvironmentVariable[] = [
      { key: "TRIGGER_SECRET_KEY", value: "secret123" },
      { key: "TRIGGER_API_URL", value: "https://api.example.com" },
      { key: "NORMAL_VAR", value: "normal" },
    ];

    const result = removeBlacklistedVariables(variables);

    expect(result).toEqual([{ key: "NORMAL_VAR", value: "normal" }]);
  });

  it("should handle empty input array", () => {
    const variables: EnvironmentVariable[] = [];

    const result = removeBlacklistedVariables(variables);

    expect(result).toEqual([]);
  });

  it("should handle mixed case variables", () => {
    const variables: EnvironmentVariable[] = [
      { key: "trigger_secret_key", value: "secret123" }, // Different case
      { key: "NORMAL_VAR", value: "normal" },
    ];

    const result = removeBlacklistedVariables(variables);

    // Should keep only the whitelisted OTEL_LOG_LEVEL and NORMAL_VAR
    // Note: The function is case-sensitive, so different case variables should pass through
    expect(result).toEqual([
      { key: "trigger_secret_key", value: "secret123" },
      { key: "NORMAL_VAR", value: "normal" },
    ]);
  });

  it("should handle variables with empty values", () => {
    const variables: EnvironmentVariable[] = [
      { key: "TRIGGER_SECRET_KEY", value: "" },
      { key: "NORMAL_VAR", value: "" },
    ];

    const result = removeBlacklistedVariables(variables);

    expect(result).toEqual([{ key: "NORMAL_VAR", value: "" }]);
  });

  it("should handle all types of rules in a single array", () => {
    const variables: EnvironmentVariable[] = [
      // Exact matches (should be removed)
      { key: "TRIGGER_SECRET_KEY", value: "secret123" },
      { key: "TRIGGER_API_URL", value: "https://api.example.com" },
      // Normal variables (should be kept)
      { key: "NORMAL_VAR", value: "normal" },
      { key: "DATABASE_URL", value: "postgres://..." },
    ];

    const result = removeBlacklistedVariables(variables);

    expect(result).toEqual([
      { key: "NORMAL_VAR", value: "normal" },
      { key: "DATABASE_URL", value: "postgres://..." },
    ]);
  });
});

describe("isBlacklistedVariable", () => {
  it("blacklists the platform-managed keys", () => {
    expect(isBlacklistedVariable("TRIGGER_SECRET_KEY")).toBe(true);
    expect(isBlacklistedVariable("TRIGGER_API_URL")).toBe(true);
  });

  it("allows ordinary user keys", () => {
    expect(isBlacklistedVariable("DATABASE_URL")).toBe(false);
    expect(isBlacklistedVariable("MY_API_KEY")).toBe(false);
  });
});

describe("isReservedForExternalSync", () => {
  it("reserves every key the repository would reject", () => {
    expect(isReservedForExternalSync("TRIGGER_SECRET_KEY")).toBe(true);
    expect(isReservedForExternalSync("TRIGGER_API_URL")).toBe(true);
  });

  it("reserves deploy-managed keys that are not blacklisted", () => {
    expect(isReservedForExternalSync("TRIGGER_VERSION")).toBe(true);
    expect(isReservedForExternalSync("TRIGGER_PREVIEW_BRANCH")).toBe(true);
  });

  it("does not reserve ordinary user keys", () => {
    expect(isReservedForExternalSync("DATABASE_URL")).toBe(false);
    expect(isReservedForExternalSync("MY_API_KEY")).toBe(false);
  });
});
