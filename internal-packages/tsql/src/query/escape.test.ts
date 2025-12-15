import { describe, it, expect } from "vitest";
import {
  escapeClickHouseIdentifier,
  escapeTSQLIdentifier,
  escapeClickHouseString,
  escapeTSQLString,
  getClickHouseType,
  SQLValueEscaper,
  safeIdentifier,
} from "./escape.js";
import { QueryError } from "./errors.js";

describe("escapeClickHouseIdentifier", () => {
  it("should pass through simple identifiers", () => {
    expect(escapeClickHouseIdentifier("id")).toBe("id");
    expect(escapeClickHouseIdentifier("user_name")).toBe("user_name");
    expect(escapeClickHouseIdentifier("Column1")).toBe("Column1");
    expect(escapeClickHouseIdentifier("_private")).toBe("_private");
  });

  it("should escape identifiers with special characters", () => {
    expect(escapeClickHouseIdentifier("my column")).toBe("`my column`");
    expect(escapeClickHouseIdentifier("table-name")).toBe("`table-name`");
    expect(escapeClickHouseIdentifier("column.with.dots")).toBe("`column.with.dots`");
  });

  it("should escape identifiers starting with numbers", () => {
    expect(escapeClickHouseIdentifier("1column")).toBe("`1column`");
    expect(escapeClickHouseIdentifier("123")).toBe("`123`");
  });

  it("should escape backticks in identifiers", () => {
    expect(escapeClickHouseIdentifier("column`name")).toBe("`column\\`name`");
  });

  it("should escape control characters", () => {
    expect(escapeClickHouseIdentifier("col\nname")).toBe("`col\\nname`");
    expect(escapeClickHouseIdentifier("col\tname")).toBe("`col\\tname`");
  });

  it("should throw for identifiers containing %", () => {
    expect(() => escapeClickHouseIdentifier("column%name")).toThrow(QueryError);
  });
});

describe("escapeTSQLIdentifier", () => {
  it("should pass through simple identifiers", () => {
    expect(escapeTSQLIdentifier("id")).toBe("id");
    expect(escapeTSQLIdentifier("user_name")).toBe("user_name");
  });

  it("should allow dollar signs in identifiers", () => {
    expect(escapeTSQLIdentifier("$property")).toBe("$property");
    expect(escapeTSQLIdentifier("property$value")).toBe("property$value");
  });

  it("should handle numeric identifiers", () => {
    expect(escapeTSQLIdentifier(0)).toBe("0");
    expect(escapeTSQLIdentifier(123)).toBe("123");
  });

  it("should throw for identifiers containing %", () => {
    expect(() => escapeTSQLIdentifier("column%name")).toThrow(QueryError);
  });
});

describe("SQLValueEscaper", () => {
  describe("ClickHouse dialect", () => {
    const escaper = new SQLValueEscaper({ dialect: "clickhouse" });

    it("should escape null", () => {
      expect(escaper.visit(null)).toBe("NULL");
      expect(escaper.visit(undefined)).toBe("NULL");
    });

    it("should escape booleans as numbers", () => {
      expect(escaper.visit(true)).toBe("1");
      expect(escaper.visit(false)).toBe("0");
    });

    it("should escape integers", () => {
      expect(escaper.visit(0)).toBe("0");
      expect(escaper.visit(42)).toBe("42");
      expect(escaper.visit(-100)).toBe("-100");
    });

    it("should escape floats", () => {
      expect(escaper.visit(3.14)).toBe("3.14");
      expect(escaper.visit(-0.5)).toBe("-0.5");
    });

    it("should escape special floats", () => {
      expect(escaper.visit(NaN)).toBe("NaN");
      expect(escaper.visit(Infinity)).toBe("Inf");
      expect(escaper.visit(-Infinity)).toBe("-Inf");
    });

    it("should escape strings with quotes", () => {
      expect(escaper.visit("hello")).toBe("'hello'");
      expect(escaper.visit("hello'world")).toBe("'hello\\'world'");
    });

    it("should escape strings with control characters", () => {
      expect(escaper.visit("line1\nline2")).toBe("'line1\\nline2'");
      expect(escaper.visit("col1\tcol2")).toBe("'col1\\tcol2'");
    });

    it("should escape arrays", () => {
      expect(escaper.visit([1, 2, 3])).toBe("[1, 2, 3]");
      expect(escaper.visit(["a", "b"])).toBe("['a', 'b']");
      expect(escaper.visit(["hello", "world"])).toBe("['hello', 'world']");
    });

    it("should escape nested arrays", () => {
      expect(
        escaper.visit([
          [1, 2],
          [3, 4],
        ])
      ).toBe("[[1, 2], [3, 4]]");
    });

    it("should escape dates with toDateTime64", () => {
      const date = new Date("2024-01-15T10:30:00.500Z");
      const result = escaper.visit(date);
      expect(result).toContain("toDateTime64");
      expect(result).toContain("2024-01-15");
    });
  });

  describe("TSQL dialect", () => {
    const escaper = new SQLValueEscaper({ dialect: "tsql" });

    it("should escape booleans as keywords", () => {
      expect(escaper.visit(true)).toBe("true");
      expect(escaper.visit(false)).toBe("false");
    });

    it("should escape dates with toDateTime", () => {
      const date = new Date("2024-01-15T10:30:00.500Z");
      const result = escaper.visit(date);
      expect(result).toContain("toDateTime");
      expect(result).toContain("2024-01-15");
    });
  });
});

describe("escapeClickHouseString", () => {
  it("should escape string values", () => {
    expect(escapeClickHouseString("test")).toBe("'test'");
  });

  it("should handle null", () => {
    expect(escapeClickHouseString(null)).toBe("NULL");
  });

  it("should handle numbers", () => {
    expect(escapeClickHouseString(42)).toBe("42");
  });
});

describe("escapeTSQLString", () => {
  it("should escape string values", () => {
    expect(escapeTSQLString("test")).toBe("'test'");
  });

  it("should handle booleans differently from ClickHouse", () => {
    expect(escapeTSQLString(true)).toBe("true");
    expect(escapeTSQLString(false)).toBe("false");
  });
});

describe("getClickHouseType", () => {
  it("should return String for strings", () => {
    expect(getClickHouseType("hello")).toBe("String");
  });

  it("should return UInt8 for booleans", () => {
    expect(getClickHouseType(true)).toBe("UInt8");
    expect(getClickHouseType(false)).toBe("UInt8");
  });

  it("should return Int32 for small integers", () => {
    expect(getClickHouseType(42)).toBe("Int32");
    expect(getClickHouseType(-100)).toBe("Int32");
  });

  it("should return Int64 for large integers", () => {
    expect(getClickHouseType(3000000000)).toBe("Int64");
    expect(getClickHouseType(-3000000000)).toBe("Int64");
  });

  it("should return Float64 for floats", () => {
    expect(getClickHouseType(3.14)).toBe("Float64");
  });

  it("should return DateTime64(6) for dates", () => {
    expect(getClickHouseType(new Date())).toBe("DateTime64(6)");
  });

  it("should return Array type for arrays", () => {
    expect(getClickHouseType(["a", "b"])).toBe("Array(String)");
    expect(getClickHouseType([1, 2])).toBe("Array(Int32)");
    expect(getClickHouseType([])).toBe("Array(String)");
  });

  it("should return Nullable(String) for null", () => {
    expect(getClickHouseType(null)).toBe("Nullable(String)");
    expect(getClickHouseType(undefined)).toBe("Nullable(String)");
  });
});

describe("safeIdentifier", () => {
  it("should return identifier unchanged if no %", () => {
    expect(safeIdentifier("column")).toBe("column");
    expect(safeIdentifier("table_name")).toBe("table_name");
  });

  it("should remove % characters", () => {
    expect(safeIdentifier("column%name")).toBe("columnname");
    expect(safeIdentifier("%%test%%")).toBe("test");
  });
});
