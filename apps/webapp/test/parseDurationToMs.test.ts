import { describe, it, expect } from "vitest";
import { parseDurationToMs } from "~/v3/utils/durations";

describe("parseDurationToMs", () => {
  it("parses milliseconds", () => {
    expect(parseDurationToMs("100ms")).toBe(100);
    expect(parseDurationToMs("1500ms")).toBe(1500);
    expect(parseDurationToMs("0ms")).toBe(0);
  });

  it("parses seconds", () => {
    expect(parseDurationToMs("1s")).toBe(1000);
    expect(parseDurationToMs("30s")).toBe(30000);
    expect(parseDurationToMs("1.5s")).toBe(1500);
    expect(parseDurationToMs("0.5s")).toBe(500);
  });

  it("parses minutes", () => {
    expect(parseDurationToMs("1m")).toBe(60000);
    expect(parseDurationToMs("5m")).toBe(300000);
    expect(parseDurationToMs("0.5m")).toBe(30000);
  });

  it("parses hours", () => {
    expect(parseDurationToMs("1h")).toBe(3600000);
    expect(parseDurationToMs("24h")).toBe(86400000);
    expect(parseDurationToMs("0.5h")).toBe(1800000);
  });

  it("parses days", () => {
    expect(parseDurationToMs("1d")).toBe(86400000);
    expect(parseDurationToMs("7d")).toBe(604800000);
  });

  it("throws on invalid format", () => {
    expect(() => parseDurationToMs("invalid")).toThrow();
    expect(() => parseDurationToMs("1x")).toThrow();
    expect(() => parseDurationToMs("")).toThrow();
    expect(() => parseDurationToMs("ms")).toThrow();
    expect(() => parseDurationToMs("10")).toThrow();
  });

  it("throws on negative values (invalid regex)", () => {
    expect(() => parseDurationToMs("-1s")).toThrow();
  });
});

