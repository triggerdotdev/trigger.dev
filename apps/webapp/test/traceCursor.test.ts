import { describe, expect, it } from "vitest";
import { decodeTraceCursor, encodeTraceCursor } from "~/v3/eventRepository/traceCursor";

const encodeRaw = (value: unknown) =>
  Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

describe("trace cursor", () => {
  it("round-trips a cursor", () => {
    const cursor = { startTime: "1756720800000000123", spanId: "a1b2c3d4" };
    const decoded = decodeTraceCursor(encodeTraceCursor(cursor));
    expect(decoded.isOk() && decoded.value).toEqual(cursor);
  });

  it("accepts the largest Int64 start time", () => {
    const cursor = { startTime: "9223372036854775807", spanId: "a" };
    const decoded = decodeTraceCursor(encodeTraceCursor(cursor));
    expect(decoded.isOk() && decoded.value).toEqual(cursor);
  });

  it("produces a URL-safe token", () => {
    const token = encodeTraceCursor({ startTime: "1756720800000000123", spanId: "??>>~~" });
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it.each([
    ["not base64 JSON", "%%%"],
    ["invalid JSON", encodeRaw("{not json")],
    ["a non-object", encodeRaw(42)],
    ["a missing start time", encodeRaw({ s: "span" })],
    ["a missing span id", encodeRaw({ t: "123" })],
    ["a non-numeric start time", encodeRaw({ t: "12a3", s: "span" })],
    ["a negative start time", encodeRaw({ t: "-123", s: "span" })],
    ["an empty span id", encodeRaw({ t: "123", s: "" })],
    ["a start time above Int64", encodeRaw({ t: "9223372036854775808", s: "span" })],
    ["a 20-digit start time", encodeRaw({ t: "99999999999999999999", s: "span" })],
    ["an empty token", ""],
  ])("rejects %s", (_, token) => {
    const decoded = decodeTraceCursor(token);
    expect(decoded.isErr() && decoded.error).toBe("invalid_cursor");
  });
});
