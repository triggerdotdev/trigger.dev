import { describe, it, expect } from "vitest";
import { ServiceValidationError } from "~/v3/services/common.server";
import { assertNoDuplicateTaskIds } from "~/v3/services/duplicateTaskIds.server";

function task(partial: {
  id: string;
  filePath?: string;
  exportName?: string;
  triggerSource?: string;
}) {
  return {
    filePath: "src/trigger/example.ts",
    exportName: "exampleTask",
    ...partial,
  } as any;
}

describe("assertNoDuplicateTaskIds", () => {
  it("does not throw when all task ids are unique", () => {
    const tasks = [task({ id: "a" }), task({ id: "b" }), task({ id: "c" })];

    expect(() => assertNoDuplicateTaskIds(tasks)).not.toThrow();
  });

  it("throws a ServiceValidationError when a task id is duplicated", () => {
    const tasks = [task({ id: "a" }), task({ id: "a" })];

    expect(() => assertNoDuplicateTaskIds(tasks)).toThrow(ServiceValidationError);
  });

  it("reports a 400 and names the duplicate id and its files", () => {
    const tasks = [
      task({ id: "report", filePath: "src/trigger/report.ts" }),
      task({ id: "report", filePath: "src/trigger/scheduled.ts" }),
    ];

    let error: unknown;
    try {
      assertNoDuplicateTaskIds(tasks);
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(ServiceValidationError);
    const validationError = error as ServiceValidationError;
    expect(validationError.status).toBe(400);
    expect(validationError.message).toContain("report");
    expect(validationError.message).toContain("src/trigger/report.ts");
    expect(validationError.message).toContain("src/trigger/scheduled.ts");
  });

  it("detects duplicates across different task types (a schedule and a regular task sharing an id)", () => {
    const tasks = [
      task({ id: "report", triggerSource: undefined, filePath: "src/trigger/report.ts" }),
      task({ id: "report", triggerSource: "schedule", filePath: "src/trigger/scheduled.ts" }),
    ];

    expect(() => assertNoDuplicateTaskIds(tasks)).toThrow(ServiceValidationError);
  });
});
