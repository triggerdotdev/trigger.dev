import { describe, expect, it } from "vitest";
import { toErrorGroupOptions } from "./errorGroupOptions";

describe("toErrorGroupOptions", () => {
  it("maps a group to fingerprint, task and a short label", () => {
    expect(
      toErrorGroupOptions([
        { fingerprint: "fp1", taskIdentifier: "my-task", errorType: "Error", errorMessage: "boom" },
      ])
    ).toEqual([{ fingerprint: "fp1", taskIdentifier: "my-task", label: "my-task · Error: boom" }]);
  });

  it("truncates long labels to 80 chars and collapses whitespace", () => {
    const [option] = toErrorGroupOptions([
      {
        fingerprint: "fp",
        taskIdentifier: "t",
        errorType: "Error",
        errorMessage: `line1\n${"x".repeat(200)}`,
      },
    ]);
    expect(option!.label).toHaveLength(80);
    expect(option!.label.endsWith("…")).toBe(true);
    expect(option!.label).not.toContain("\n");
  });
});
