import { describe, expect, it } from "vitest";
import { storedQueueName } from "./queue-name";

describe("storedQueueName", () => {
  it("adds the prefix a task queue is stored with", () => {
    expect(storedQueueName({ type: "task", name: "my-task" })).toBe("task/my-task");
  });

  it("keeps a prefix that is already there", () => {
    expect(storedQueueName({ type: "task", name: "task/my-task" })).toBe("task/my-task");
  });

  // Malformed input reaches this, and the contract is one prefix, not "one fewer than it had".
  it("leaves one prefix however many the name arrived with", () => {
    expect(storedQueueName({ type: "task", name: "task/task/my-task" })).toBe("task/my-task");
    expect(storedQueueName({ type: "task", name: "task/task/task/my-task" })).toBe("task/my-task");
  });

  it("leaves a custom queue alone, prefix-shaped name and all", () => {
    expect(storedQueueName({ type: "custom", name: "my-queue" })).toBe("my-queue");
    expect(storedQueueName({ type: "custom", name: "task/my-queue" })).toBe("task/my-queue");
  });
});
