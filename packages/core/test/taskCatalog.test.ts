import { describe, expect, it } from "vitest";
import { StandardResourceCatalog } from "../src/v3/resource-catalog/standardResourceCatalog.js";
import type { TaskMetadataWithFunctions } from "../src/v3/types/index.js";

function task(id: string, maxDuration = 60): TaskMetadataWithFunctions {
  return {
    id,
    maxDuration,
    fns: {
      run: async () => undefined,
    },
  } as TaskMetadataWithFunctions;
}

describe("StandardResourceCatalog — tasks", () => {
  it("throws when the same task id is registered from different files", () => {
    const catalog = new StandardResourceCatalog();

    catalog.setCurrentFileContext("trigger/first.ts", "first");
    catalog.registerTaskMetadata(task("duplicate-task", 1800));

    catalog.setCurrentFileContext("trigger/second.ts", "second");

    let error: unknown;

    try {
      catalog.registerTaskMetadata(task("duplicate-task", 7200));
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      'Duplicate Trigger.dev task id "duplicate-task" found'
    );
    expect((error as Error).message).toContain("trigger/first.ts (first)");
    expect((error as Error).message).toContain("trigger/second.ts (second)");
    expect((error as Error).message).toContain(
      "Task ids must be unique inside a project"
    );
  });

  it("allows re-registering the same task id from the same file context", () => {
    const catalog = new StandardResourceCatalog();

    catalog.setCurrentFileContext("trigger/task.ts", "task");
    catalog.registerTaskMetadata(task("same-task", 1800));
    catalog.registerTaskMetadata(task("same-task", 7200));

    expect(catalog.getTaskManifest("same-task")).toMatchObject({
      id: "same-task",
      maxDuration: 7200,
      filePath: "trigger/task.ts",
      entryPoint: "task",
    });
  });
});
