import { describe, it, expect } from "vitest";
import { escapeSqlStringLiteral } from "../app/services/realtimeClient.server";

describe("escapeSqlStringLiteral", () => {
  it("leaves ordinary tag values unchanged", () => {
    expect(escapeSqlStringLiteral("important")).toBe("important");
    expect(escapeSqlStringLiteral("user_42")).toBe("user_42");
    expect(escapeSqlStringLiteral("")).toBe("");
  });

  it("doubles a single quote", () => {
    expect(escapeSqlStringLiteral("O'Brien")).toBe("O''Brien");
  });

  it("neutralizes the tags injection payload from #3739", () => {
    const literal = `'${escapeSqlStringLiteral("test' OR '1'='1")}'`;
    expect(literal).toBe("'test'' OR ''1''=''1'");
    expect(literal.replace(/''/g, "")).toBe("'test OR 1=1'");
  });

  it("escapes every quote, not just the first", () => {
    expect(escapeSqlStringLiteral("a'b'c'")).toBe("a''b''c''");
  });
});
