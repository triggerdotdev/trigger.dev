import { task } from "@trigger.dev/sdk";

// Defined in a module that's loaded via `await import(...)` from the parent
// task's run() function. Pre-fix: the task() call below fires while
// `_currentFileContext` is unset, so the registration is silently dropped.
// Post-fix: registered with sentinel file metadata + console.warn fires once.
export const lazyChildTask = task({
  id: "lazy-child-task",
  run: async (payload: { value: string }) => {
    return { received: payload.value };
  },
});
