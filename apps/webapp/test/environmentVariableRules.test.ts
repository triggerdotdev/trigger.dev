import { describe, it, expect } from "vitest";
import { removeBlacklistedVariables } from "../app/v3/environmentVariables/environmentVariablesRepository.server";
import type { EnvironmentVariable } from "../app/v3/environmentVariables/repository";

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

  it("should remove variables with blacklisted prefixes", () => {
    const variables: EnvironmentVariable[] = [
      { key: "OTEL_SERVICE_NAME", value: "my-service" },
      { key: "OTEL_TRACE_SAMPLER", value: "always_on" },
      { key: "NORMAL_VAR", value: "normal" },
    ];

    const result = removeBlacklistedVariables(variables);

    expect(result).toEqual([{ key: "NORMAL_VAR", value: "normal" }]);
  });

  it("should keep whitelisted variables even if they match a blacklisted prefix", () => {
    const variables: EnvironmentVariable[] = [
      { key: "OTEL_LOG_LEVEL", value: "debug" },
      { key: "OTEL_SERVICE_NAME", value: "my-service" },
      { key: "NORMAL_VAR", value: "normal" },
    ];

    const result = removeBlacklistedVariables(variables);

    expect(result).toEqual([
      { key: "OTEL_LOG_LEVEL", value: "debug" },
      { key: "NORMAL_VAR", value: "normal" },
    ]);
  });

  it("should handle empty input array", () => {
    const variables: EnvironmentVariable[] = [];

    const result = removeBlacklistedVariables(variables);

    expect(result).toEqual([]);
  });

  it("should handle mixed case variables", () => {
    const variables: EnvironmentVariable[] = [
      { key: "trigger_secret_key", value: "secret123" }, // Different case
      { key: "OTEL_LOG_LEVEL", value: "debug" },
      { key: "otel_service_name", value: "my-service" }, // Different case
      { key: "NORMAL_VAR", value: "normal" },
    ];

    const result = removeBlacklistedVariables(variables);

    // Should keep only the whitelisted OTEL_LOG_LEVEL and NORMAL_VAR
    // Note: The function is case-sensitive, so different case variables should pass through
    expect(result).toEqual([
      { key: "trigger_secret_key", value: "secret123" },
      { key: "OTEL_LOG_LEVEL", value: "debug" },
      { key: "otel_service_name", value: "my-service" },
      { key: "NORMAL_VAR", value: "normal" },
    ]);
  });

  it("should handle variables with empty values", () => {
    const variables: EnvironmentVariable[] = [
      { key: "TRIGGER_SECRET_KEY", value: "" },
      { key: "OTEL_SERVICE_NAME", value: "" },
      { key: "OTEL_LOG_LEVEL", value: "" },
      { key: "NORMAL_VAR", value: "" },
    ];

    const result = removeBlacklistedVariables(variables);

    expect(result).toEqual([
      { key: "OTEL_LOG_LEVEL", value: "" },
      { key: "NORMAL_VAR", value: "" },
    ]);
  });

  it("should handle all types of rules in a single array", () => {
    const variables: EnvironmentVariable[] = [
      // Exact matches (should be removed)
      { key: "TRIGGER_SECRET_KEY", value: "secret123" },
      { key: "TRIGGER_API_URL", value: "https://api.example.com" },
      // Prefix matches (should be removed)
      { key: "OTEL_SERVICE_NAME", value: "my-service" },
      { key: "OTEL_TRACE_SAMPLER", value: "always_on" },
      // Whitelist exception (should be kept)
      { key: "OTEL_LOG_LEVEL", value: "debug" },
      // Normal variables (should be kept)
      { key: "NORMAL_VAR", value: "normal" },
      { key: "DATABASE_URL", value: "postgres://..." },
    ];

    const result = removeBlacklistedVariables(variables);

    expect(result).toEqual([
      { key: "OTEL_LOG_LEVEL", value: "debug" },
      { key: "NORMAL_VAR", value: "normal" },
      { key: "DATABASE_URL", value: "postgres://..." },
    ]);
  });
});
