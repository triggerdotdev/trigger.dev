import { describe, it, expect } from "vitest";
import {
  column,
  getUserFriendlyValue,
  getInternalValue,
  getAllowedUserValues,
  isValidUserValue,
  isVirtualColumn,
  getVirtualColumnExpression,
  type ColumnSchema,
} from "./schema.js";

describe("Value mapping helper functions", () => {
  const columnWithValueMap: ColumnSchema = {
    name: "status",
    ...column("String"),
    valueMap: {
      COMPLETED_SUCCESSFULLY: "Completed",
      COMPLETED_WITH_ERRORS: "Completed with errors",
      SYSTEM_FAILURE: "System failure",
      PENDING: "Pending",
      EXECUTING: "Running",
      FAILED: "Failed",
    },
  };

  const columnWithAllowedValues: ColumnSchema = {
    name: "status",
    ...column("String"),
    allowedValues: ["completed", "pending", "failed"],
  };

  const columnWithNoRestrictions: ColumnSchema = {
    name: "task_identifier",
    ...column("String"),
  };

  describe("getUserFriendlyValue", () => {
    it("should return user-friendly value for internal value", () => {
      expect(getUserFriendlyValue(columnWithValueMap, "COMPLETED_SUCCESSFULLY")).toBe("Completed");
      expect(getUserFriendlyValue(columnWithValueMap, "PENDING")).toBe("Pending");
      expect(getUserFriendlyValue(columnWithValueMap, "EXECUTING")).toBe("Running");
    });

    it("should be case-insensitive for internal value lookup", () => {
      expect(getUserFriendlyValue(columnWithValueMap, "completed_successfully")).toBe("Completed");
      expect(getUserFriendlyValue(columnWithValueMap, "Completed_Successfully")).toBe("Completed");
      expect(getUserFriendlyValue(columnWithValueMap, "COMPLETED_SUCCESSFULLY")).toBe("Completed");
    });

    it("should return original value if no mapping exists", () => {
      expect(getUserFriendlyValue(columnWithValueMap, "UNKNOWN_STATUS")).toBe("UNKNOWN_STATUS");
    });

    it("should return original value if column has no valueMap", () => {
      expect(getUserFriendlyValue(columnWithNoRestrictions, "any_value")).toBe("any_value");
    });
  });

  describe("getInternalValue", () => {
    it("should return internal value for user-friendly value", () => {
      expect(getInternalValue(columnWithValueMap, "Completed")).toBe("COMPLETED_SUCCESSFULLY");
      expect(getInternalValue(columnWithValueMap, "Pending")).toBe("PENDING");
      expect(getInternalValue(columnWithValueMap, "Running")).toBe("EXECUTING");
    });

    it("should be case-insensitive for user-friendly value lookup", () => {
      expect(getInternalValue(columnWithValueMap, "completed")).toBe("COMPLETED_SUCCESSFULLY");
      expect(getInternalValue(columnWithValueMap, "COMPLETED")).toBe("COMPLETED_SUCCESSFULLY");
      expect(getInternalValue(columnWithValueMap, "Completed")).toBe("COMPLETED_SUCCESSFULLY");
    });

    it("should return original value if no mapping exists", () => {
      expect(getInternalValue(columnWithValueMap, "Unknown")).toBe("Unknown");
    });

    it("should return original value if column has no valueMap", () => {
      expect(getInternalValue(columnWithNoRestrictions, "any_value")).toBe("any_value");
    });

    it("should handle multi-word user-friendly values", () => {
      expect(getInternalValue(columnWithValueMap, "Completed with errors")).toBe(
        "COMPLETED_WITH_ERRORS"
      );
      expect(getInternalValue(columnWithValueMap, "completed with errors")).toBe(
        "COMPLETED_WITH_ERRORS"
      );
      expect(getInternalValue(columnWithValueMap, "System failure")).toBe("SYSTEM_FAILURE");
    });
  });

  describe("getAllowedUserValues", () => {
    it("should return user-friendly values from valueMap", () => {
      const values = getAllowedUserValues(columnWithValueMap);

      expect(values).toContain("Completed");
      expect(values).toContain("Pending");
      expect(values).toContain("Running");
      expect(values).toContain("Failed");
      expect(values).toContain("Completed with errors");
      expect(values).toContain("System failure");
      expect(values).toHaveLength(6);
    });

    it("should return allowedValues if no valueMap exists", () => {
      const values = getAllowedUserValues(columnWithAllowedValues);

      expect(values).toEqual(["completed", "pending", "failed"]);
    });

    it("should prefer valueMap over allowedValues", () => {
      const columnWithBoth: ColumnSchema = {
        name: "status",
        ...column("String"),
        allowedValues: ["internal1", "internal2"],
        valueMap: {
          internal1: "User 1",
          internal2: "User 2",
        },
      };

      const values = getAllowedUserValues(columnWithBoth);

      expect(values).toEqual(["User 1", "User 2"]);
    });

    it("should return empty array for column with no restrictions", () => {
      const values = getAllowedUserValues(columnWithNoRestrictions);

      expect(values).toEqual([]);
    });
  });

  describe("isValidUserValue", () => {
    it("should return true for valid user-friendly values", () => {
      expect(isValidUserValue(columnWithValueMap, "Completed")).toBe(true);
      expect(isValidUserValue(columnWithValueMap, "Pending")).toBe(true);
      expect(isValidUserValue(columnWithValueMap, "Running")).toBe(true);
    });

    it("should be case-insensitive", () => {
      expect(isValidUserValue(columnWithValueMap, "completed")).toBe(true);
      expect(isValidUserValue(columnWithValueMap, "COMPLETED")).toBe(true);
      expect(isValidUserValue(columnWithValueMap, "running")).toBe(true);
    });

    it("should return false for invalid values", () => {
      expect(isValidUserValue(columnWithValueMap, "Unknown")).toBe(false);
      expect(isValidUserValue(columnWithValueMap, "COMPLETED_SUCCESSFULLY")).toBe(false); // internal value, not user-friendly
    });

    it("should return true for any value if column has no restrictions", () => {
      expect(isValidUserValue(columnWithNoRestrictions, "any_value")).toBe(true);
      expect(isValidUserValue(columnWithNoRestrictions, "another")).toBe(true);
    });

    it("should validate against allowedValues if no valueMap", () => {
      expect(isValidUserValue(columnWithAllowedValues, "completed")).toBe(true);
      expect(isValidUserValue(columnWithAllowedValues, "COMPLETED")).toBe(true);
      expect(isValidUserValue(columnWithAllowedValues, "unknown")).toBe(false);
    });

    it("should handle multi-word values", () => {
      expect(isValidUserValue(columnWithValueMap, "Completed with errors")).toBe(true);
      expect(isValidUserValue(columnWithValueMap, "completed with errors")).toBe(true);
      expect(isValidUserValue(columnWithValueMap, "System failure")).toBe(true);
    });
  });
});

describe("Virtual column helper functions", () => {
  const virtualColumn: ColumnSchema = {
    name: "execution_duration",
    ...column("Nullable(Int64)"),
    expression: "dateDiff('millisecond', started_at, completed_at)",
    description: "Time between started_at and completed_at in milliseconds",
  };

  const regularColumn: ColumnSchema = {
    name: "status",
    ...column("String"),
  };

  const columnWithEmptyExpression: ColumnSchema = {
    name: "bad_column",
    ...column("String"),
    expression: "",
  };

  describe("isVirtualColumn", () => {
    it("should return true for columns with expression defined", () => {
      expect(isVirtualColumn(virtualColumn)).toBe(true);
    });

    it("should return false for regular columns without expression", () => {
      expect(isVirtualColumn(regularColumn)).toBe(false);
    });

    it("should return false for columns with empty expression", () => {
      expect(isVirtualColumn(columnWithEmptyExpression)).toBe(false);
    });

    it("should return false for columns with undefined expression", () => {
      const col: ColumnSchema = {
        name: "test",
        ...column("String"),
        expression: undefined,
      };
      expect(isVirtualColumn(col)).toBe(false);
    });
  });

  describe("getVirtualColumnExpression", () => {
    it("should return the expression for virtual columns", () => {
      expect(getVirtualColumnExpression(virtualColumn)).toBe(
        "dateDiff('millisecond', started_at, completed_at)"
      );
    });

    it("should return undefined for regular columns", () => {
      expect(getVirtualColumnExpression(regularColumn)).toBeUndefined();
    });

    it("should return undefined for columns with empty expression", () => {
      expect(getVirtualColumnExpression(columnWithEmptyExpression)).toBeUndefined();
    });
  });

  describe("virtual column schema definition", () => {
    it("should allow defining virtual columns with all standard column options", () => {
      const virtualWithOptions: ColumnSchema = {
        name: "computed_value",
        type: "Float64",
        expression: "usage_duration_ms / 1000.0",
        selectable: true,
        filterable: true,
        sortable: true,
        groupable: false, // Might not want to group by computed values
        description: "Usage duration in seconds",
      };

      expect(isVirtualColumn(virtualWithOptions)).toBe(true);
      expect(virtualWithOptions.groupable).toBe(false);
      expect(virtualWithOptions.selectable).toBe(true);
    });

    it("should support complex expressions with ClickHouse functions", () => {
      const complexVirtual: ColumnSchema = {
        name: "is_long_running",
        ...column("UInt8"),
        expression:
          "if(completed_at IS NOT NULL AND started_at IS NOT NULL, dateDiff('second', started_at, completed_at) > 60, 0)",
      };

      expect(isVirtualColumn(complexVirtual)).toBe(true);
      expect(getVirtualColumnExpression(complexVirtual)).toContain("dateDiff");
      expect(getVirtualColumnExpression(complexVirtual)).toContain("if(");
    });
  });
});

