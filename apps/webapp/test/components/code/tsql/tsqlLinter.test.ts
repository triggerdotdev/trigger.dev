import { describe, it, expect } from "vitest";
import { isValidTSQLQuery, getTSQLError } from "~/components/code/tsql/tsqlLinter";

describe("tsqlLinter", () => {
  describe("isValidTSQLQuery", () => {
    it("should return true for empty queries", () => {
      expect(isValidTSQLQuery("")).toBe(true);
      expect(isValidTSQLQuery("   ")).toBe(true);
    });

    it("should return true for valid SELECT queries", () => {
      expect(isValidTSQLQuery("SELECT * FROM users")).toBe(true);
      expect(isValidTSQLQuery("SELECT id, name FROM users WHERE status = 'active'")).toBe(true);
      expect(isValidTSQLQuery("SELECT count(*) FROM users GROUP BY status")).toBe(true);
    });

    it("should return true for queries with ORDER BY", () => {
      expect(isValidTSQLQuery("SELECT * FROM users ORDER BY created_at DESC")).toBe(true);
    });

    it("should return true for queries with LIMIT", () => {
      expect(isValidTSQLQuery("SELECT * FROM users LIMIT 10")).toBe(true);
      expect(isValidTSQLQuery("SELECT * FROM users LIMIT 10 OFFSET 20")).toBe(true);
    });

    it("should return true for queries with JOINs", () => {
      expect(isValidTSQLQuery("SELECT * FROM users JOIN orders ON users.id = orders.user_id")).toBe(
        true
      );
      expect(
        isValidTSQLQuery(
          "SELECT * FROM users LEFT JOIN orders ON users.id = orders.user_id"
        )
      ).toBe(true);
    });

    it("should return false for invalid syntax", () => {
      expect(isValidTSQLQuery("SELEC * FROM users")).toBe(false);
      expect(isValidTSQLQuery("SELECT * FORM users")).toBe(false);
      expect(isValidTSQLQuery("SELECT FROM users")).toBe(false);
    });

    it("should return false for incomplete queries", () => {
      expect(isValidTSQLQuery("SELECT * FROM")).toBe(false);
      expect(isValidTSQLQuery("SELECT")).toBe(false);
    });
  });

  describe("getTSQLError", () => {
    it("should return null for empty queries", () => {
      expect(getTSQLError("")).toBeNull();
      expect(getTSQLError("   ")).toBeNull();
    });

    it("should return null for valid queries", () => {
      expect(getTSQLError("SELECT * FROM users")).toBeNull();
      expect(getTSQLError("SELECT id, name FROM users WHERE id = 1")).toBeNull();
    });

    it("should return error message for invalid queries", () => {
      const error = getTSQLError("SELEC * FROM users");
      expect(error).not.toBeNull();
      expect(typeof error).toBe("string");
    });

    it("should include position information in error", () => {
      const error = getTSQLError("SELECT * FORM users");
      expect(error).not.toBeNull();
      // Error message should contain line/column info
      expect(error).toContain("line");
    });

    it("should handle unclosed string literals", () => {
      const error = getTSQLError("SELECT * FROM users WHERE name = 'test");
      expect(error).not.toBeNull();
    });
  });
});

