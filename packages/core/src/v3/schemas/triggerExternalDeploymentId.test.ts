import { describe, expect, it } from "vitest";
import { BatchTriggerTaskItem, TriggerTaskRequestBody } from "./api.js";
import { RunAnnotations } from "./runEngine.js";

describe("TriggerTaskRequestBody.options.externalDeploymentId", () => {
  it("accepts an id alongside lockToVersion — neither suppresses the other", () => {
    const result = TriggerTaskRequestBody.safeParse({
      payload: {},
      options: { lockToVersion: "20260807.1", externalDeploymentId: "commit-abc" },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.options?.lockToVersion).toBe("20260807.1");
      expect(result.data.options?.externalDeploymentId).toBe("commit-abc");
    }
  });

  it("imposes no format", () => {
    for (const id of ["a1b2c3", "v1.2.3", "release/2026-08-07", "refs/heads/main", "1"]) {
      const result = TriggerTaskRequestBody.safeParse({
        payload: {},
        options: { externalDeploymentId: id },
      });
      expect(result.success, `expected ${id} to be accepted`).toBe(true);
    }
  });

  it("trims surrounding whitespace", () => {
    const result = TriggerTaskRequestBody.safeParse({
      payload: {},
      options: { externalDeploymentId: "  commit-abc  " },
    });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.options?.externalDeploymentId).toBe("commit-abc");
  });

  it.each(["", "   "])("treats %j as absent rather than a 400", (value) => {
    const result = TriggerTaskRequestBody.safeParse({
      payload: {},
      options: { externalDeploymentId: value },
    });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.options?.externalDeploymentId).toBeUndefined();
  });

  it("accepts exactly 128 characters and rejects 129", () => {
    expect(
      TriggerTaskRequestBody.safeParse({
        payload: {},
        options: { externalDeploymentId: "a".repeat(128) },
      }).success
    ).toBe(true);

    expect(
      TriggerTaskRequestBody.safeParse({
        payload: {},
        options: { externalDeploymentId: "a".repeat(129) },
      }).success
    ).toBe(false);
  });

  it("measures the length limit after trimming, matching the deploy side", () => {
    expect(
      TriggerTaskRequestBody.safeParse({
        payload: {},
        options: { externalDeploymentId: `  ${"a".repeat(128)}  ` },
      }).success
    ).toBe(true);
  });
});

describe("BatchTriggerTaskItem.options.externalDeploymentId", () => {
  it("carries the id per item, so it survives asynchronous materialisation", () => {
    const result = BatchTriggerTaskItem.safeParse({
      task: "my-task",
      payload: {},
      options: { externalDeploymentId: "  commit-abc  " },
    });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.options?.externalDeploymentId).toBe("commit-abc");
  });

  it("applies the same 128-character cap as the single-trigger body", () => {
    expect(
      BatchTriggerTaskItem.safeParse({
        task: "my-task",
        payload: {},
        options: { externalDeploymentId: "a".repeat(129) },
      }).success
    ).toBe(false);
  });
});

describe("RunAnnotations.externalDeploymentId", () => {
  it("is optional, so every existing annotations blob still parses", () => {
    const result = RunAnnotations.safeParse({
      triggerSource: "sdk",
      triggerAction: "trigger",
      rootTriggerSource: "sdk",
    });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.externalDeploymentId).toBeUndefined();
  });

  it("round-trips the id when present", () => {
    const result = RunAnnotations.safeParse({
      triggerSource: "sdk",
      triggerAction: "trigger",
      rootTriggerSource: "sdk",
      externalDeploymentId: "commit-abc",
    });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.externalDeploymentId).toBe("commit-abc");
  });
});
