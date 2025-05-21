import { describe, it, expect } from "vitest";
import { deduplicateVariableArray } from "../app/v3/environmentVariables/environmentVariablesRepository.server";
import type { EnvironmentVariable } from "../app/v3/environmentVariables/repository";

describe("Deduplicate variables", () => {
  it("should keep later variables when there are duplicates", () => {
    const variables: EnvironmentVariable[] = [
      { key: "API_KEY", value: "old_value" },
      { key: "API_KEY", value: "new_value" },
    ];

    const result = deduplicateVariableArray(variables);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ key: "API_KEY", value: "new_value" });
  });

  it("should preserve order of unique variables", () => {
    const variables: EnvironmentVariable[] = [
      { key: "FIRST", value: "first" },
      { key: "SECOND", value: "second" },
      { key: "THIRD", value: "third" },
    ];

    const result = deduplicateVariableArray(variables);

    expect(result).toHaveLength(3);
    expect(result[0].key).toBe("FIRST");
    expect(result[1].key).toBe("SECOND");
    expect(result[2].key).toBe("THIRD");
  });

  it("should handle multiple duplicates with later values taking precedence", () => {
    const variables: EnvironmentVariable[] = [
      { key: "DB_URL", value: "old_db" },
      { key: "API_KEY", value: "old_key" },
      { key: "DB_URL", value: "new_db" },
      { key: "API_KEY", value: "new_key" },
    ];

    const result = deduplicateVariableArray(variables);

    expect(result).toHaveLength(2);
    expect(result.find((v) => v.key === "DB_URL")?.value).toBe("new_db");
    expect(result.find((v) => v.key === "API_KEY")?.value).toBe("new_key");
  });

  it("should handle empty array", () => {
    const result = deduplicateVariableArray([]);
    expect(result).toEqual([]);
  });

  it("should handle array with no duplicates", () => {
    const variables: EnvironmentVariable[] = [
      { key: "VAR1", value: "value1" },
      { key: "VAR2", value: "value2" },
    ];

    const result = deduplicateVariableArray(variables);

    expect(result).toHaveLength(2);
    expect(result).toEqual(variables);
  });
});
