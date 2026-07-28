import { describe, expect, test } from "vitest";
import { summarizeItemsByTask } from "~/v3/services/batchTriggerV3.server";

describe("summarizeItemsByTask", () => {
  test("returns counts and task identifiers without the underlying items", () => {
    const itemsByTask = {
      "my-task": [
        { task: "my-task", payload: { secret: "value" }, options: { metadata: { pii: "yes" } } },
        { task: "my-task", payload: { secret: "value-2" }, options: {} },
      ],
      "other-task": [{ task: "other-task", payload: {}, options: {} }],
    };

    const summary = summarizeItemsByTask(itemsByTask);

    expect(summary).toEqual({
      taskIdentifiers: ["my-task", "other-task"],
      itemCountsByTask: { "my-task": 2, "other-task": 1 },
      totalItemCount: 3,
    });

    // The summary must never contain the raw items, their payloads, or their options -
    // just identifiers and counts.
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("payload");
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("metadata");
    expect(serialized).not.toContain("pii");
  });

  test("returns empty collections when there are no idempotent items", () => {
    expect(summarizeItemsByTask({})).toEqual({
      taskIdentifiers: [],
      itemCountsByTask: {},
      totalItemCount: 0,
    });
  });
});
