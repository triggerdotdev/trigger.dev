import { describe, it, expect } from "vitest";
import { isValidTRQLQuery, getTRQLError } from "~/components/code/trql/trqlLinter";

describe("trqlLinter", () => {
  describe("isValidTRQLQuery", () => {
    it("should return true for empty queries", () => {
      expect(isValidTRQLQuery("")).toBe(true);
      expect(isValidTRQLQuery("   ")).toBe(true);
    });

    it("should return true for valid SELECT queries", () => {
      expect(isValidTRQLQuery("SELECT * FROM users")).toBe(true);
      expect(isValidTRQLQuery("SELECT id, name FROM users WHERE status = 'active'")).toBe(true);
      expect(isValidTRQLQuery("SELECT count(*) FROM users GROUP BY status")).toBe(true);
    });

    it("should return true for queries with ORDER BY", () => {
      expect(isValidTRQLQuery("SELECT * FROM users ORDER BY created_at DESC")).toBe(true);
    });

    it("should return true for queries with LIMIT", () => {
      expect(isValidTRQLQuery("SELECT * FROM users LIMIT 10")).toBe(true);
      expect(isValidTRQLQuery("SELECT * FROM users LIMIT 10 OFFSET 20")).toBe(true);
    });

    it("should return true for queries with JOINs", () => {
      expect(isValidTRQLQuery("SELECT * FROM users JOIN orders ON users.id = orders.user_id")).toBe(
        true
      );
      expect(
        isValidTRQLQuery(
          "SELECT * FROM users LEFT JOIN orders ON users.id = orders.user_id"
        )
      ).toBe(true);
    });

    it("should return false for invalid syntax", () => {
      expect(isValidTRQLQuery("SELEC * FROM users")).toBe(false);
      expect(isValidTRQLQuery("SELECT * FORM users")).toBe(false);
      expect(isValidTRQLQuery("SELECT FROM users")).toBe(false);
    });

    it("should return false for incomplete queries", () => {
      expect(isValidTRQLQuery("SELECT * FROM")).toBe(false);
      expect(isValidTRQLQuery("SELECT")).toBe(false);
    });
  });

  describe("getTRQLError", () => {
    it("should return null for empty queries", () => {
      expect(getTRQLError("")).toBeNull();
      expect(getTRQLError("   ")).toBeNull();
    });

    it("should return null for valid queries", () => {
      expect(getTRQLError("SELECT * FROM users")).toBeNull();
      expect(getTRQLError("SELECT id, name FROM users WHERE id = 1")).toBeNull();
    });

    it("should return error message for invalid queries", () => {
      const error = getTRQLError("SELEC * FROM users");
      expect(error).not.toBeNull();
      expect(typeof error).toBe("string");
    });

    it("should include position information in error", () => {
      const error = getTRQLError("SELECT * FORM users");
      expect(error).not.toBeNull();
      // Error message should contain line/column info
      expect(error).toContain("line");
    });

    it("should handle unclosed string literals", () => {
      const error = getTRQLError("SELECT * FROM users WHERE name = 'test");
      expect(error).not.toBeNull();
    });
  });
});

