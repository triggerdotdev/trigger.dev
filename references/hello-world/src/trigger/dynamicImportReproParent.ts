import { logger, task } from "@trigger.dev/sdk";

// Triggers the dynamic-import silent-drop path. The child task's `task()`
// definition lives in a module loaded via `await import(...)` inside this
// parent's run() — so its registration would land outside the worker's
// cold-load context window.
export const dynamicImportReproParent = task({
  id: "dynamic-import-repro-parent",
  run: async () => {
    logger.info("parent: about to dynamically import child task module");
    const { lazyChildTask } = await import("./dynamicImportReproChild.js");
    logger.info("parent: import complete, triggering child");
    const handle = await lazyChildTask.trigger({ value: "hello from parent" });
    logger.info("parent: child triggered", { childRunId: handle.id });
    return { childRunId: handle.id };
  },
});
