// Run-engine runs write no TaskRunAttempt rows; their output/error live on the TaskRun row.
// Before this, a run with no attempt resolved to `undefined` and was dropped from batch results.
import { describe, expect, test } from "vitest";
import type { TaskRunWithAttempts } from "~/models/taskRun.server";
import { executionResultForTaskRun } from "~/models/taskRun.server";

const base = {
  id: "r1",
  friendlyId: "run_r1",
  taskIdentifier: "my-task",
  attempts: [],
} as unknown as TaskRunWithAttempts;

describe("executionResultForTaskRun without attempt rows", () => {
  test("successful run returns the run's own output", () => {
    expect(
      executionResultForTaskRun({
        ...base,
        status: "COMPLETED_SUCCESSFULLY",
        output: '{"a":1}',
        outputType: "application/json",
      })
    ).toEqual({
      ok: true,
      id: "run_r1",
      taskIdentifier: "my-task",
      output: '{"a":1}',
      outputType: "application/json",
    });
  });

  test("failed run returns the run's own error", () => {
    const error = { type: "BUILT_IN_ERROR", name: "Err", message: "boom", stackTrace: "" };
    expect(
      executionResultForTaskRun({ ...base, status: "COMPLETED_WITH_ERRORS", error } as never)
    ).toEqual({ ok: false, id: "run_r1", taskIdentifier: "my-task", error });
  });

  test("an attempt row still wins when present", () => {
    expect(
      executionResultForTaskRun({
        ...base,
        status: "COMPLETED_SUCCESSFULLY",
        output: "from-run",
        outputType: "text/plain",
        attempts: [{ status: "COMPLETED", output: "from-attempt", outputType: "text/plain" }],
      } as never)
    ).toMatchObject({ ok: true, output: "from-attempt" });
  });
});
