import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NO_FILE_CONTEXT,
  StandardResourceCatalog,
} from "../src/v3/resource-catalog/standardResourceCatalog.js";

// Regression tests for COULD_NOT_FIND_EXECUTOR on warm worker processes when
// a task's `task()` / `schemaTask()` call is evaluated during another task's
// execution (e.g. as a side effect of `await import(...)` of a module that
// contains a task definition).
//
// Production throw site:
//   - managed-run-worker.ts:566 (post-wrap)
//   - dev-run-worker.ts:578 (post-wrap)
// Pre-fix symptom: `resourceCatalog.getTask(execution.task.id)` returned
// undefined even after the worker re-imported the task entrypoint.
//
// Pre-fix mechanism: `registerTaskMetadata` silently returned when
// `_currentFileContext` was unset. Any `task()` call firing during a
// running task's run() / lifecycle hooks (directly, or transitively via a
// dynamic import) hit the silent guard. Node's ESM module cache then
// prevented recovery — the worker's setContext + re-import fallback didn't
// re-evaluate the module body, so the `task()` call never fired again.
//
// Post-fix: the runtime workers wrap their `executor.execute(...)` call with
// `setCurrentFileContext(NO_FILE_CONTEXT, NO_FILE_CONTEXT)` so any `task()`
// call firing during execution registers normally with sentinel file
// metadata. The catalog detects the sentinel and emits a one-time warning
// per task id to keep the bundle-shape pattern visible. The indexer never
// sets this sentinel context — its behavior is unchanged.

describe("StandardResourceCatalog — runtime registration via sentinel context", () => {
  afterEach(() => {
    delete (globalThis as { __catalogRegisterTaskMetadata?: unknown })
      .__catalogRegisterTaskMetadata;
    vi.restoreAllMocks();
  });

  it("silently drops registration when no context is set (indexer's invariant)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const catalog = new StandardResourceCatalog();

    catalog.registerTaskMetadata({
      id: "no-context-task",
      fns: { run: async () => "ok" },
    });

    expect(catalog.getTask("no-context-task")).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it(
    "registers normally and warns once when the sentinel context is set " +
      "(simulates the worker's executor wrap)",
    () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const catalog = new StandardResourceCatalog();

      catalog.setCurrentFileContext(NO_FILE_CONTEXT, NO_FILE_CONTEXT);
      catalog.registerTaskMetadata({
        id: "lazy-task",
        fns: { run: async () => "ok" },
      });
      catalog.clearCurrentFileContext();

      const registered = catalog.getTask("lazy-task");
      expect(registered).toBeDefined();
      expect(registered?.id).toBe("lazy-task");
      expect(registered?.filePath).toBe(NO_FILE_CONTEXT);
      expect(registered?.entryPoint).toBe(NO_FILE_CONTEXT);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain("lazy-task");
    }
  );

  it(
    "warm-start path: a task whose top-level definition fires during a " +
      "dynamic import inside the sentinel wrap remains findable; the " +
      "worker's setContext + re-import fallback (managed-run-worker.ts:482) " +
      "is not needed",
    async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const catalog = new StandardResourceCatalog();

      (globalThis as { __catalogRegisterTaskMetadata?: unknown })
        .__catalogRegisterTaskMetadata = (
        task: Parameters<StandardResourceCatalog["registerTaskMetadata"]>[0]
      ) => {
        catalog.registerTaskMetadata(task);
      };

      // Simulate the worker wrap: setContext(NO_FILE_CONTEXT) → run user code
      // (which does a dynamic import) → clearContext.
      catalog.setCurrentFileContext(NO_FILE_CONTEXT, NO_FILE_CONTEXT);
      await import("./fixtures/dynamic-task-module.mjs");
      catalog.clearCurrentFileContext();

      const registered = catalog.getTask("lazy-task");
      expect(registered).toBeDefined();
      expect(registered?.filePath).toBe(NO_FILE_CONTEXT);
    }
  );

  it("warns at most once per task id under the sentinel context", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const catalog = new StandardResourceCatalog();

    catalog.setCurrentFileContext(NO_FILE_CONTEXT, NO_FILE_CONTEXT);

    const register = (id: string) =>
      catalog.registerTaskMetadata({
        id,
        fns: { run: async () => "ok" },
      });

    register("task-a");
    register("task-a");
    register("task-a");
    expect(warn).toHaveBeenCalledTimes(1);

    register("task-b");
    expect(warn).toHaveBeenCalledTimes(2);

    catalog.clearCurrentFileContext();
  });

  it(
    "control: real file context registers without firing the sentinel warning",
    async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const catalog = new StandardResourceCatalog();

      (globalThis as { __catalogRegisterTaskMetadata?: unknown })
        .__catalogRegisterTaskMetadata = (
        task: Parameters<StandardResourceCatalog["registerTaskMetadata"]>[0]
      ) => {
        catalog.registerTaskMetadata(task);
      };

      catalog.setCurrentFileContext(
        "/app/dist/lazy-task.entry.mjs",
        "src/tasks/lazy-task.ts"
      );
      await import("./fixtures/dynamic-task-module.mjs?control");
      catalog.clearCurrentFileContext();

      const task = catalog.getTask("lazy-task");
      expect(task).toBeDefined();
      expect(task?.filePath).toBe("/app/dist/lazy-task.entry.mjs");
      expect(task?.entryPoint).toBe("src/tasks/lazy-task.ts");
      expect(warn).not.toHaveBeenCalled();
    }
  );
});

describe("StandardResourceCatalog — duplicate task id collisions", () => {
  function register(catalog: StandardResourceCatalog, id: string, filePath: string) {
    catalog.setCurrentFileContext(filePath, filePath);
    catalog.registerTaskMetadata({ id, fns: { run: async () => "ok" } });
    catalog.clearCurrentFileContext();
  }

  it("reports no collisions when every task id is unique", () => {
    const catalog = new StandardResourceCatalog();

    register(catalog, "a", "src/a.ts");
    register(catalog, "b", "src/b.ts");

    expect(catalog.listTaskIdCollisions()).toEqual([]);
  });

  it("records a collision with both file paths when an id is reused across files", () => {
    const catalog = new StandardResourceCatalog();

    register(catalog, "dupe", "src/a.ts");
    register(catalog, "dupe", "src/b.ts");

    expect(catalog.listTaskIdCollisions()).toEqual([
      { id: "dupe", filePaths: ["src/a.ts", "src/b.ts"] },
    ]);
  });

  it("collects every distinct file path when an id is defined three or more times", () => {
    const catalog = new StandardResourceCatalog();

    register(catalog, "dupe", "src/a.ts");
    register(catalog, "dupe", "src/b.ts");
    register(catalog, "dupe", "src/c.ts");

    expect(catalog.listTaskIdCollisions()).toEqual([
      { id: "dupe", filePaths: ["src/a.ts", "src/b.ts", "src/c.ts"] },
    ]);
  });

  it("records two definitions in the same file (e.g. two exports sharing an id)", () => {
    const catalog = new StandardResourceCatalog();

    register(catalog, "dupe", "src/dupe.ts");
    register(catalog, "dupe", "src/dupe.ts");

    expect(catalog.listTaskIdCollisions()).toEqual([
      { id: "dupe", filePaths: ["src/dupe.ts", "src/dupe.ts"] },
    ]);
  });
});
