import { describe, expect, it } from "vitest";
import { formatRunOutput } from "./devOutput.js";

describe("formatRunOutput", () => {
  it("returns undefined when the run returned nothing", () => {
    expect(formatRunOutput(undefined, "application/json")).toBeUndefined();
  });

  it("shows JSON and plain text output as is", () => {
    expect(formatRunOutput('{"greeting":"Hello"}', "application/json")).toBe(
      '{"greeting":"Hello"}'
    );
    expect(formatRunOutput("Hello", "text/plain")).toBe("Hello");
  });

  it("drops superjson's type metadata", () => {
    const output = JSON.stringify({
      json: { createdAt: "2026-10-18T10:00:00.000Z" },
      meta: { values: { createdAt: ["Date"] } },
    });

    expect(formatRunOutput(output, "application/super+json")).toBe(
      '{"createdAt":"2026-10-18T10:00:00.000Z"}'
    );
  });

  it("truncates long output and says how much was cut", () => {
    const output = JSON.stringify({ data: "x".repeat(2_000) });
    const formatted = formatRunOutput(output, "application/json")!;

    expect(formatted.startsWith('{"data":"xxx')).toBe(true);
    expect(formatted.endsWith(`… (${output.length - 1_000} more characters)`)).toBe(true);
  });

  it("doesn't show output that was offloaded to object storage", () => {
    expect(formatRunOutput("packets/run_123/output.json", "application/store")).toBe(
      "(too large to show here, view it in the dashboard)"
    );
  });
});
