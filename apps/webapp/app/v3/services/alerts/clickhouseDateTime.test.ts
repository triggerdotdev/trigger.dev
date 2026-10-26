import { describe, expect, it } from "vitest";
import { parseClickhouseDateTime } from "./clickhouseDateTime";

describe("parseClickhouseDateTime", () => {
  it("parses DateTime as UTC", () => {
    expect(parseClickhouseDateTime("2026-07-01 12:30:15").toISOString()).toBe(
      "2026-07-01T12:30:15.000Z"
    );
  });

  it("parses DateTime64 as UTC", () => {
    expect(parseClickhouseDateTime("2026-07-01 12:30:15.123").toISOString()).toBe(
      "2026-07-01T12:30:15.123Z"
    );
  });

  it("keeps explicit ISO zones", () => {
    expect(parseClickhouseDateTime("2026-07-01T12:30:15Z").toISOString()).toBe(
      "2026-07-01T12:30:15.000Z"
    );
  });
});
