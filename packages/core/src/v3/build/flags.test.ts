import { describe, it, expect } from "vitest";
import { dedupFlags } from "./flags.js";

describe("dedupFlags", () => {
  it("should keep single flags unchanged", () => {
    expect(dedupFlags("--verbose")).toBe("--verbose");
    expect(dedupFlags("-v")).toBe("-v");
    expect(dedupFlags("--debug=true")).toBe("--debug=true");
  });

  it("should preserve multiple different flags", () => {
    expect(dedupFlags("--quiet --verbose")).toBe("--quiet --verbose");
    expect(dedupFlags("-v -q --log=debug")).toBe("-v -q --log=debug");
  });

  it("should use last value when flags are duplicated", () => {
    expect(dedupFlags("--debug=false --debug=true")).toBe("--debug=true");
    expect(dedupFlags("--log=info --log=warn --log=error")).toBe("--log=error");
  });

  it("should treat underscores as hyphens", () => {
    expect(dedupFlags("--debug_level=info")).toBe("--debug-level=info");
    expect(dedupFlags("--debug_level=info --debug-level=warn")).toBe("--debug-level=warn");
  });

  it("should handle mix of flags with and without values", () => {
    expect(dedupFlags("--debug=false -v --debug=true")).toBe("-v --debug=true");
    expect(dedupFlags("-v --quiet -v")).toBe("--quiet -v");
  });

  // Edge cases
  it("should handle empty string", () => {
    expect(dedupFlags("")).toBe("");
  });

  it("should handle multiple spaces between flags", () => {
    expect(dedupFlags("--debug=false    --verbose   --debug=true")).toBe("--verbose --debug=true");
  });

  it("should handle flags with empty values", () => {
    expect(dedupFlags("--path= --path=foo")).toBe("--path=foo");
    expect(dedupFlags("--path=foo --path=")).toBe("--path=");
  });

  it("should preserve values containing equals signs", () => {
    expect(dedupFlags("--url=http://example.com?foo=bar")).toBe("--url=http://example.com?foo=bar");
  });

  it("should handle flags with special characters", () => {
    expect(dedupFlags("--path=/usr/local --path=/home/user")).toBe("--path=/home/user");
    expect(dedupFlags('--name="John Doe" --name="Jane Doe"')).toBe('--name="Jane Doe"');
  });

  it("should handle multiple flag variants", () => {
    const input = "--env=dev -v --env=prod --quiet -v --env=staging";
    expect(dedupFlags(input)).toBe("--quiet -v --env=staging");
  });
});
