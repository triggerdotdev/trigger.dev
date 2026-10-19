import { describe, expect, test } from "vitest";
import { SCOPE_CAPABILITIES, scopeDetailForPreset } from "./apiKeyScopeDetail";

function preset(scopes: string[]) {
  return { id: "PRESET", available: true, label: "Preset", description: "", scopes };
}

describe("scopeDetailForPreset", () => {
  test("shows a row for every capability a restricted preset can grant", () => {
    expect(SCOPE_CAPABILITIES.map(([key]) => key)).toEqual([
      "tasks",
      "runs",
      "batches",
      "queues",
      "sessions",
      "tags",
      "errors",
      "webhooks",
      "waitpoints",
      "deployments",
      "branches",
      "envvars",
    ]);
  });

  test("reads webhooks and errors for an observer", () => {
    const detail = scopeDetailForPreset(
      preset([
        "read:runs",
        "read:tasks",
        "read:batch",
        "read:queues",
        "read:errors",
        "read:webhooks",
      ])
    );

    expect(detail?.caps.webhooks).toEqual([1, ["read:webhooks"]]);
    expect(detail?.caps.errors).toEqual([1, ["read:errors"]]);
    expect(detail?.caps.waitpoints).toBeUndefined();
  });

  test("reads and writes webhooks and errors for an operator", () => {
    const detail = scopeDetailForPreset(
      preset(["read:errors", "read:webhooks", "write:errors", "write:webhooks", "trigger:tasks"])
    );

    expect(detail?.caps.webhooks).toEqual([2, ["read:webhooks", "write:webhooks"]]);
    expect(detail?.caps.errors).toEqual([2, ["read:errors", "write:errors"]]);
  });

  test("grants no tasks to a webhooks-only key", () => {
    const detail = scopeDetailForPreset(preset(["read:webhooks", "write:webhooks"]));

    expect(detail?.caps).toEqual({ webhooks: [2, ["read:webhooks", "write:webhooks"]] });
    expect(detail?.taskLabel).toBe("No tasks");
  });

  test("reads and writes waitpoints for a waitpoints-only key", () => {
    const detail = scopeDetailForPreset(preset(["read:waitpoints", "write:waitpoints"]));

    expect(detail?.caps).toEqual({ waitpoints: [2, ["read:waitpoints", "write:waitpoints"]] });
    expect(detail?.taskLabel).toBe("No tasks");
  });

  test("ignores task identifiers when mapping task scopes", () => {
    const detail = scopeDetailForPreset(preset(["trigger:tasks:send-email"]));

    expect(detail?.caps.tasks).toEqual([3, ["trigger:tasks:send-email"]]);
  });

  test("marks admin presets as full access", () => {
    expect(scopeDetailForPreset(preset(["admin"]))).toEqual({
      admin: true,
      taskLabel: "All tasks",
      caps: {},
    });
  });
});
