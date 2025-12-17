import { describe, it, expect } from "vitest";
import {
  column,
  getUserFriendlyValue,
  getInternalValue,
  getAllowedUserValues,
  isValidUserValue,
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

