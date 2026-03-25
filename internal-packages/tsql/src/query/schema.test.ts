import { describe, it, expect } from "vitest";
import {
  column,
  getUserFriendlyValue,
  getInternalValue,
  getAllowedUserValues,
  isValidUserValue,
  isVirtualColumn,
  getVirtualColumnExpression,
  hasFieldMapping,
  getExternalValue,
  getInternalValueFromMapping,
  getInternalValueFromMappingCaseInsensitive,
  sanitizeErrorMessage,
  type ColumnSchema,
  type FieldMappings,
  type TableSchema,
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

describe("Field mapping helper functions (runtime dynamic mappings)", () => {
  const fieldMappings: FieldMappings = {
    project: {
      cm12345: "my-project-ref",
      cm67890: "other-project",
      cmABCDE: "Mixed-Case-Project",
    },
    environment: {
      env123: "production",
      env456: "staging",
    },
  };

  const columnWithFieldMapping: ColumnSchema = {
    name: "project_ref",
    clickhouseName: "project_id",
    ...column("String"),
    fieldMapping: "project",
  };

  const columnWithoutFieldMapping: ColumnSchema = {
    name: "status",
    ...column("String"),
  };

  const columnWithEmptyFieldMapping: ColumnSchema = {
    name: "test",
    ...column("String"),
    fieldMapping: "",
  };

  describe("hasFieldMapping", () => {
    it("should return true for columns with fieldMapping defined", () => {
      expect(hasFieldMapping(columnWithFieldMapping)).toBe(true);
    });

    it("should return false for columns without fieldMapping", () => {
      expect(hasFieldMapping(columnWithoutFieldMapping)).toBe(false);
    });

    it("should return false for columns with empty fieldMapping", () => {
      expect(hasFieldMapping(columnWithEmptyFieldMapping)).toBe(false);
    });

    it("should return false for columns with undefined fieldMapping", () => {
      const col: ColumnSchema = {
        name: "test",
        ...column("String"),
        fieldMapping: undefined,
      };
      expect(hasFieldMapping(col)).toBe(false);
    });
  });

  describe("getExternalValue", () => {
    it("should return external value for internal value", () => {
      expect(getExternalValue(fieldMappings, "project", "cm12345")).toBe("my-project-ref");
      expect(getExternalValue(fieldMappings, "project", "cm67890")).toBe("other-project");
      expect(getExternalValue(fieldMappings, "environment", "env123")).toBe("production");
    });

    it("should return null if internal value is not found in mapping", () => {
      expect(getExternalValue(fieldMappings, "project", "unknown_id")).toBeNull();
      expect(getExternalValue(fieldMappings, "environment", "unknown_env")).toBeNull();
    });

    it("should return null if mapping name does not exist", () => {
      expect(getExternalValue(fieldMappings, "nonexistent", "cm12345")).toBeNull();
    });

    it("should return null for empty mappings", () => {
      expect(getExternalValue({}, "project", "cm12345")).toBeNull();
    });

    it("should be case-sensitive for internal values", () => {
      // Internal IDs should be matched exactly
      expect(getExternalValue(fieldMappings, "project", "CM12345")).toBeNull();
      expect(getExternalValue(fieldMappings, "project", "cm12345")).toBe("my-project-ref");
    });
  });

  describe("getInternalValueFromMapping", () => {
    it("should return internal value for external value", () => {
      expect(getInternalValueFromMapping(fieldMappings, "project", "my-project-ref")).toBe(
        "cm12345"
      );
      expect(getInternalValueFromMapping(fieldMappings, "project", "other-project")).toBe(
        "cm67890"
      );
      expect(getInternalValueFromMapping(fieldMappings, "environment", "production")).toBe(
        "env123"
      );
    });

    it("should return null if external value is not found", () => {
      expect(getInternalValueFromMapping(fieldMappings, "project", "unknown-ref")).toBeNull();
    });

    it("should return null if mapping name does not exist", () => {
      expect(
        getInternalValueFromMapping(fieldMappings, "nonexistent", "my-project-ref")
      ).toBeNull();
    });

    it("should return null for empty mappings", () => {
      expect(getInternalValueFromMapping({}, "project", "my-project-ref")).toBeNull();
    });

    it("should be case-sensitive for external values", () => {
      // This is the case-sensitive version
      expect(getInternalValueFromMapping(fieldMappings, "project", "MY-PROJECT-REF")).toBeNull();
      expect(getInternalValueFromMapping(fieldMappings, "project", "my-project-ref")).toBe(
        "cm12345"
      );
    });
  });

  describe("getInternalValueFromMappingCaseInsensitive", () => {
    it("should return internal value for external value (case-insensitive)", () => {
      expect(
        getInternalValueFromMappingCaseInsensitive(fieldMappings, "project", "my-project-ref")
      ).toBe("cm12345");
      expect(
        getInternalValueFromMappingCaseInsensitive(fieldMappings, "project", "MY-PROJECT-REF")
      ).toBe("cm12345");
      expect(
        getInternalValueFromMappingCaseInsensitive(fieldMappings, "project", "My-Project-Ref")
      ).toBe("cm12345");
    });

    it("should return null if external value is not found (even case-insensitive)", () => {
      expect(
        getInternalValueFromMappingCaseInsensitive(fieldMappings, "project", "unknown-ref")
      ).toBeNull();
    });

    it("should return null if mapping name does not exist", () => {
      expect(
        getInternalValueFromMappingCaseInsensitive(fieldMappings, "nonexistent", "my-project-ref")
      ).toBeNull();
    });

    it("should return null for empty mappings", () => {
      expect(
        getInternalValueFromMappingCaseInsensitive({}, "project", "my-project-ref")
      ).toBeNull();
    });

    it("should handle mixed case external values correctly", () => {
      expect(
        getInternalValueFromMappingCaseInsensitive(fieldMappings, "project", "mixed-case-project")
      ).toBe("cmABCDE");
      expect(
        getInternalValueFromMappingCaseInsensitive(fieldMappings, "project", "MIXED-CASE-PROJECT")
      ).toBe("cmABCDE");
    });
  });

  describe("field mapping column schema definition", () => {
    it("should allow defining columns with fieldMapping", () => {
      const col: ColumnSchema = {
        name: "project_ref",
        clickhouseName: "project_id",
        type: "String",
        fieldMapping: "project",
        description: "Project reference (external identifier)",
      };

      expect(hasFieldMapping(col)).toBe(true);
      expect(col.clickhouseName).toBe("project_id");
      expect(col.fieldMapping).toBe("project");
    });

    it("should allow fieldMapping with all standard column options", () => {
      const col: ColumnSchema = {
        name: "project_ref",
        clickhouseName: "project_id",
        ...column("String"),
        fieldMapping: "project",
        selectable: true,
        filterable: true,
        sortable: true,
        groupable: true,
      };

      expect(hasFieldMapping(col)).toBe(true);
      expect(col.selectable).toBe(true);
      expect(col.filterable).toBe(true);
    });
  });
});

describe("Error message sanitization", () => {
  // Test schema mimicking the real runs schema
  const runsSchema: TableSchema = {
    name: "runs",
    clickhouseName: "trigger_dev.task_runs_v2",
    description: "Task runs table",
    tenantColumns: {
      organizationId: "organization_id",
      projectId: "project_id",
      environmentId: "environment_id",
    },
    columns: {
      run_id: {
        name: "run_id",
        clickhouseName: "friendly_id",
        ...column("String"),
      },
      triggered_at: {
        name: "triggered_at",
        clickhouseName: "created_at",
        ...column("DateTime64"),
      },
      machine: {
        name: "machine",
        clickhouseName: "machine_preset",
        ...column("String"),
      },
      status: {
        name: "status",
        // No clickhouseName - same as name
        ...column("String"),
      },
      task_identifier: {
        name: "task_identifier",
        // No clickhouseName - same as name
        ...column("String"),
      },
    },
  };

  describe("sanitizeErrorMessage", () => {
    it("should replace fully qualified table.column references", () => {
      const error = "Missing column trigger_dev.task_runs_v2.friendly_id in query";
      const sanitized = sanitizeErrorMessage(error, [runsSchema]);
      expect(sanitized).toBe("Missing column runs.run_id in query");
    });

    it("should replace standalone table names", () => {
      const error = "Table trigger_dev.task_runs_v2 does not exist";
      const sanitized = sanitizeErrorMessage(error, [runsSchema]);
      expect(sanitized).toBe("Table runs does not exist");
    });

    it("should replace standalone column names with different clickhouseName", () => {
      const error = "Unknown identifier: friendly_id";
      const sanitized = sanitizeErrorMessage(error, [runsSchema]);
      expect(sanitized).toBe("Unknown identifier: run_id");
    });

    it("should replace multiple occurrences in the same message", () => {
      const error =
        "Cannot compare friendly_id with created_at: incompatible types in trigger_dev.task_runs_v2";
      const sanitized = sanitizeErrorMessage(error, [runsSchema]);
      expect(sanitized).toBe("Cannot compare run_id with triggered_at: incompatible types in runs");
    });

    it("should not replace column names that have no clickhouseName mapping", () => {
      const error = "Invalid value for column status";
      const sanitized = sanitizeErrorMessage(error, [runsSchema]);
      expect(sanitized).toBe("Invalid value for column status");
    });

    it("should handle error messages with quoted identifiers", () => {
      const error = "Column 'machine_preset' is not of type String";
      const sanitized = sanitizeErrorMessage(error, [runsSchema]);
      expect(sanitized).toBe("Column 'machine' is not of type String");
    });

    it("should handle error messages with backtick identifiers", () => {
      const error = "Unknown column `friendly_id` in table";
      const sanitized = sanitizeErrorMessage(error, [runsSchema]);
      expect(sanitized).toBe("Unknown column `run_id` in table");
    });

    it("should not replace partial matches within larger identifiers", () => {
      const error = "Column my_friendly_id_column not found";
      const sanitized = sanitizeErrorMessage(error, [runsSchema]);
      // Should not replace "friendly_id" within "my_friendly_id_column"
      expect(sanitized).toBe("Column my_friendly_id_column not found");
    });

    it("should return original message if no schemas provided", () => {
      const error = "Some error with trigger_dev.task_runs_v2";
      const sanitized = sanitizeErrorMessage(error, []);
      expect(sanitized).toBe("Some error with trigger_dev.task_runs_v2");
    });

    it("should return original message if no matches found", () => {
      const error = "Generic database error occurred";
      const sanitized = sanitizeErrorMessage(error, [runsSchema]);
      expect(sanitized).toBe("Generic database error occurred");
    });

    it("should handle multiple tables", () => {
      const eventsSchema: TableSchema = {
        name: "events",
        clickhouseName: "trigger_dev.task_events",
        description: "Task events table",
        tenantColumns: {
          organizationId: "organization_id",
          projectId: "project_id",
          environmentId: "environment_id",
        },
        columns: {
          event_id: {
            name: "event_id",
            clickhouseName: "internal_event_id",
            ...column("String"),
          },
        },
      };

      const error =
        "Cannot join trigger_dev.task_runs_v2 with trigger_dev.task_events on internal_event_id";
      const sanitized = sanitizeErrorMessage(error, [runsSchema, eventsSchema]);
      expect(sanitized).toBe("Cannot join runs with events on event_id");
    });

    it("should handle real ClickHouse error format", () => {
      const error =
        "Unable to query clickhouse: Code: 47. DB::Exception: Missing columns: 'friendly_id' while processing query";
      const sanitized = sanitizeErrorMessage(error, [runsSchema]);
      // Should remove the "Unable to query clickhouse:" prefix
      expect(sanitized).toBe(
        "Code: 47. DB::Exception: Missing columns: 'run_id' while processing query"
      );
    });

    it("should remove 'Unable to query clickhouse:' prefix", () => {
      const error = "Unable to query clickhouse: Something went wrong";
      const sanitized = sanitizeErrorMessage(error, [runsSchema]);
      expect(sanitized).toBe("Something went wrong");
      expect(sanitized).not.toContain("Unable to query clickhouse");
    });

    it("should handle error with column in parentheses", () => {
      const error = "Function count(friendly_id) expects different arguments";
      const sanitized = sanitizeErrorMessage(error, [runsSchema]);
      expect(sanitized).toBe("Function count(run_id) expects different arguments");
    });

    it("should handle error with column after comma", () => {
      const error = "SELECT friendly_id, created_at FROM table";
      const sanitized = sanitizeErrorMessage(error, [runsSchema]);
      expect(sanitized).toBe("SELECT run_id, triggered_at FROM table");
    });

    it("should NOT replace column names in 'Did you mean' error messages", () => {
      // When a user types an internal ClickHouse column name, we show "Did you mean X?"
      // The sanitizer should NOT replace the column name in this case, as it would
      // turn "Unknown column 'created_at'. Did you mean 'triggered_at'?" into
      // "Unknown column 'triggered_at'. Did you mean 'triggered_at'?" which is confusing
      const error = 'Unknown column "created_at". Did you mean "triggered_at"?';
      const sanitized = sanitizeErrorMessage(error, [runsSchema]);
      // Should preserve both the original column name AND the suggestion
      expect(sanitized).toBe('Unknown column "created_at". Did you mean "triggered_at"?');
    });

    it("should prioritize longer matches (table.column before standalone column)", () => {
      // This tests that we replace "trigger_dev.task_runs_v2.friendly_id" as a unit,
      // not "trigger_dev.task_runs_v2" and then "friendly_id" separately
      const error = "Error in trigger_dev.task_runs_v2.friendly_id";
      const sanitized = sanitizeErrorMessage(error, [runsSchema]);
      expect(sanitized).toBe("Error in runs.run_id");
    });

    it("should remove tenant isolation filters from error messages", () => {
      const error =
        "Unknown identifier in scope SELECT run_id FROM runs WHERE ((organization_id = 'org123') AND (project_id = 'proj456') AND (environment_id = 'env789')) AND (status = 'Failed')";
      const sanitized = sanitizeErrorMessage(error, [runsSchema]);
      expect(sanitized).not.toContain("organization_id");
      expect(sanitized).not.toContain("project_id");
      expect(sanitized).not.toContain("environment_id");
      expect(sanitized).toContain("status = 'Failed'");
    });

    it("should remove redundant column aliases like 'run_id AS run_id'", () => {
      const error = "Error in SELECT run_id AS run_id, machine AS machine FROM runs";
      const sanitized = sanitizeErrorMessage(error, [runsSchema]);
      expect(sanitized).toBe("Error in SELECT run_id, machine FROM runs");
    });

    it("should remove redundant table aliases like 'runs AS runs'", () => {
      const error = "Error in SELECT * FROM runs AS runs WHERE status = 'Failed'";
      const sanitized = sanitizeErrorMessage(error, [runsSchema]);
      expect(sanitized).toBe("Error in SELECT * FROM runs WHERE status = 'Failed'");
    });

    it("should handle real error with tenant filters and aliases", () => {
      const error =
        "Unable to query clickhouse: Unknown expression identifier `triggered_ata` in scope SELECT run_id AS run_id, machine AS machine FROM runs AS runs WHERE ((organization_id = 'cm5qtzpb800007cp7h6ebwt2i') AND (project_id = 'cme2p1yep00007calt8ugarkr') AND (environment_id = 'cme2p1ygj00027caln51kyiwl')) AND (status = 'Complted') ORDER BY triggered_ata DESC LIMIT 100.";
      const sanitized = sanitizeErrorMessage(error, [runsSchema]);

      // Should not contain internal prefix
      expect(sanitized).not.toContain("Unable to query clickhouse");

      // Should not contain internal IDs
      expect(sanitized).not.toContain("cm5qtzpb800007cp7h6ebwt2i");
      expect(sanitized).not.toContain("cme2p1yep00007calt8ugarkr");
      expect(sanitized).not.toContain("cme2p1ygj00027caln51kyiwl");
      expect(sanitized).not.toContain("organization_id");
      expect(sanitized).not.toContain("project_id");
      expect(sanitized).not.toContain("environment_id");

      // Should not have redundant aliases
      expect(sanitized).not.toContain("run_id AS run_id");
      expect(sanitized).not.toContain("machine AS machine");
      expect(sanitized).not.toContain("runs AS runs");

      // Should still have the user's query parts
      expect(sanitized).toContain("status = 'Complted'");
      expect(sanitized).toContain("triggered_ata");
      expect(sanitized).toContain("LIMIT 100");
    });

    it("should remove required filters like engine = 'V2'", () => {
      // Schema with required filters
      const schemaWithRequiredFilters: TableSchema = {
        name: "runs",
        clickhouseName: "trigger_dev.task_runs_v2",
        description: "Task runs table",
        tenantColumns: {
          organizationId: "organization_id",
          projectId: "project_id",
          environmentId: "environment_id",
        },
        requiredFilters: [{ column: "engine", value: "V2" }],
        columns: {
          run_id: {
            name: "run_id",
            ...column("String"),
          },
        },
      };

      const error =
        "Error in SELECT run_id FROM runs WHERE ((organization_id = 'org1') AND (engine = 'V2')) AND (status = 'Failed')";
      const sanitized = sanitizeErrorMessage(error, [schemaWithRequiredFilters]);

      expect(sanitized).not.toContain("engine = 'V2'");
      expect(sanitized).not.toContain("organization_id");
      expect(sanitized).toContain("status = 'Failed'");
    });

    it("should handle project and environment field mappings in tenant columns", () => {
      // The schema uses 'project' and 'environment' as column names with field mappings
      const schemaWithFieldMappedTenants: TableSchema = {
        name: "runs",
        clickhouseName: "trigger_dev.task_runs_v2",
        description: "Task runs table",
        tenantColumns: {
          organizationId: "organization_id",
          projectId: "project",
          environmentId: "environment",
        },
        columns: {
          run_id: {
            name: "run_id",
            ...column("String"),
          },
        },
      };

      const error =
        "Error WHERE ((organization_id = 'org1') AND (project = 'proj1') AND (environment = 'env1')) AND (status = 'ok')";
      const sanitized = sanitizeErrorMessage(error, [schemaWithFieldMappedTenants]);

      expect(sanitized).not.toContain("organization_id = 'org1'");
      expect(sanitized).not.toContain("project = 'proj1'");
      expect(sanitized).not.toContain("environment = 'env1'");
      expect(sanitized).toContain("status = 'ok'");
    });

    it("should handle queries with only automatic WHERE filters (no user WHERE clause)", () => {
      // When user writes: SELECT * FROM runs LIMIT 10
      // The compiled query becomes: SELECT * FROM runs WHERE (org_id = '...') AND (proj_id = '...') AND (env_id = '...')
      const error =
        "Unable to query clickhouse: Some error in SELECT run_id FROM runs WHERE ((organization_id = 'org1') AND (project_id = 'proj1') AND (environment_id = 'env1')) LIMIT 10";
      const sanitized = sanitizeErrorMessage(error, [runsSchema]);

      expect(sanitized).not.toContain("Unable to query clickhouse");
      expect(sanitized).not.toContain("organization_id");
      expect(sanitized).not.toContain("project_id");
      expect(sanitized).not.toContain("environment_id");
      expect(sanitized).not.toContain("WHERE");
      expect(sanitized).toContain("SELECT run_id FROM runs");
      expect(sanitized).toContain("LIMIT 10");
    });

    it("should handle queries with only automatic filters including engine filter", () => {
      const schemaWithEngine: TableSchema = {
        name: "runs",
        clickhouseName: "trigger_dev.task_runs_v2",
        description: "Task runs table",
        tenantColumns: {
          organizationId: "organization_id",
          projectId: "project_id",
          environmentId: "environment_id",
        },
        requiredFilters: [{ column: "engine", value: "V2" }],
        columns: {
          run_id: {
            name: "run_id",
            ...column("String"),
          },
        },
      };

      const error =
        "Error in SELECT * FROM runs WHERE ((organization_id = 'org1') AND (project_id = 'proj1') AND (environment_id = 'env1') AND (engine = 'V2')) ORDER BY run_id";
      const sanitized = sanitizeErrorMessage(error, [schemaWithEngine]);

      expect(sanitized).not.toContain("organization_id");
      expect(sanitized).not.toContain("project_id");
      expect(sanitized).not.toContain("environment_id");
      expect(sanitized).not.toContain("engine");
      expect(sanitized).not.toContain("WHERE");
      expect(sanitized).toContain("SELECT * FROM runs");
      expect(sanitized).toContain("ORDER BY run_id");
    });
  });
});
