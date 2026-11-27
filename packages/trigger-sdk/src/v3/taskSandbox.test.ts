import { resourceCatalog, TaskManifest, TaskResource } from "@trigger.dev/core/v3";
import { StandardResourceCatalog } from "@trigger.dev/core/v3/workers";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod/v4";
import { defineMachine, schedules, schemaTask, task } from "./preview.js";
import type { Task } from "./shared.js";
import { task as stableTask } from "./tasks.js";

function indexedTask(id: string) {
  return TaskResource.parse(TaskManifest.parse(resourceCatalog.getTaskManifest(id)));
}

describe("task sandbox registration", () => {
  beforeEach(() => {
    resourceCatalog.disable();
    resourceCatalog.setGlobalResourceCatalog(new StandardResourceCatalog());
    resourceCatalog.setCurrentFileContext("tasks.ts", "tasks.ts");
  });

  afterEach(() => {
    resourceCatalog.clearCurrentFileContext();
    resourceCatalog.disable();
  });

  it("indexes the default sandbox without additional grants, and leaves ordinary tasks unchanged", () => {
    const run = async () => undefined;

    for (const [id, sandbox] of Object.entries({
      enabled: true,
      empty: {},
      noScopes: { scopes: [] },
    })) {
      task({ id, run, sandbox });
      const indexed = indexedTask(id);
      expect(indexed).toMatchObject({ triggerSource: "sandbox", sandbox: { scopes: [] } });
      expect(indexed.sandbox?.envVars).toBeUndefined();
    }

    task({ id: "default", run });
    task({ id: "disabled", run, sandbox: false });
    expect(() => task({ id: "invalid", run, sandbox: null as never })).toThrow();
    for (const id of ["default", "disabled"]) {
      expect(indexedTask(id).sandbox).toBeUndefined();
      expect(indexedTask(id).triggerSource).toBeUndefined();
    }
  });

  it("indexes expanded presets and explicit scope templates for schema tasks", () => {
    const schema = z.object({ value: z.string() });
    schemaTask({
      id: "schema",
      schema,
      sandbox: { scopes: "basic" },
      run: async (payload) => payload.value,
    });
    schemaTask({
      id: "tool",
      schema,
      sandbox: { envVars: "all", scopes: ["basic", "oidc", "read:tasks:allowed"] },
      run: async (payload) => payload.value,
    });

    const basic = [
      "read:runs:$run",
      "write:runs:$run",
      "read:sessions:$session:in",
      "write:sessions:$session:out",
    ];
    expect(indexedTask("schema").sandbox?.scopes).toEqual(basic);
    expect(indexedTask("tool").sandbox).toMatchObject({
      envVars: "all",
      scopes: [...basic, "write:oidc", "read:tasks:allowed"],
    });
  });

  it("preserves the original trigger source when indexing declarative schedules", () => {
    schedules.task({
      id: "scheduled",
      cron: "0 * * * *",
      sandbox: { envVars: ["API_KEY"] },
      run: async () => undefined,
    });

    expect(indexedTask("scheduled")).toMatchObject({
      triggerSource: "sandbox",
      sandbox: { triggerSource: "schedule", envVars: ["API_KEY"] },
      schedule: { cron: "0 * * * *" },
    });
  });

  // Catches: `sandbox` or a `defineMachine()` machine leaking back onto the stable `task()` while
  // they are in preview
  it("accepts sandbox and a defineMachine() machine only from the preview entry point", () => {
    const box = defineMachine({ id: "box", preset: "medium-1x" });
    // @ts-expect-error sandbox is a preview option
    stableTask({ id: "stable-sandbox", sandbox: true, run: async () => undefined });
    // @ts-expect-error a defineMachine() machine is a preview option
    stableTask({ id: "stable-machine", machine: box, run: async () => undefined });

    const preview = task({
      id: "preview-machine",
      machine: box,
      run: async (payload: { value: string }) => payload.value,
    });
    expectTypeOf(preview).toEqualTypeOf<Task<"preview-machine", { value: string }, string>>();

    expect(indexedTask("preview-machine").machine).toEqual({ preset: "medium-1x", name: "box" });
  });
});
