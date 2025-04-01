import { describe, it, expect } from "vitest";
import { BoolEnv, AdditionalEnvVars } from "./envUtil.js";

describe("BoolEnv", () => {
  it("should parse string 'true' as true", () => {
    expect(BoolEnv.parse("true")).toBe(true);
    expect(BoolEnv.parse("TRUE")).toBe(true);
    expect(BoolEnv.parse("True")).toBe(true);
  });

  it("should parse string '1' as true", () => {
    expect(BoolEnv.parse("1")).toBe(true);
  });

  it("should parse string 'false' as false", () => {
    expect(BoolEnv.parse("false")).toBe(false);
    expect(BoolEnv.parse("FALSE")).toBe(false);
    expect(BoolEnv.parse("False")).toBe(false);
  });

  it("should handle whitespace", () => {
    expect(BoolEnv.parse(" true ")).toBe(true);
    expect(BoolEnv.parse(" 1 ")).toBe(true);
  });

  it("should pass through boolean values", () => {
    expect(BoolEnv.parse(true)).toBe(true);
    expect(BoolEnv.parse(false)).toBe(false);
  });

  it("should return false for invalid inputs", () => {
    expect(BoolEnv.parse("invalid")).toBe(false);
    expect(BoolEnv.parse("")).toBe(false);
  });
});

describe("AdditionalEnvVars", () => {
  it("should parse single key-value pair", () => {
    expect(AdditionalEnvVars.parse("FOO=bar")).toEqual({ FOO: "bar" });
  });

  it("should parse multiple key-value pairs", () => {
    expect(AdditionalEnvVars.parse("FOO=bar,BAZ=qux")).toEqual({
      FOO: "bar",
      BAZ: "qux",
    });
  });

  it("should handle whitespace", () => {
    expect(AdditionalEnvVars.parse(" FOO = bar , BAZ = qux ")).toEqual({
      FOO: "bar",
      BAZ: "qux",
    });
  });

  it("should return undefined for empty string", () => {
    expect(AdditionalEnvVars.parse("")).toBeUndefined();
  });

  it("should return undefined for invalid format", () => {
    expect(AdditionalEnvVars.parse("invalid")).toBeUndefined();
  });

  it("should skip invalid pairs but include valid ones", () => {
    expect(AdditionalEnvVars.parse("FOO=bar,INVALID,BAZ=qux")).toEqual({
      FOO: "bar",
      BAZ: "qux",
    });
  });

  it("should pass through undefined", () => {
    expect(AdditionalEnvVars.parse(undefined)).toBeUndefined();
  });

  it("should handle empty values", () => {
    expect(AdditionalEnvVars.parse("FOO=,BAR=value")).toEqual({
      BAR: "value",
    });
  });
});
