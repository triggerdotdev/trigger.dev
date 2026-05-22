// Fixture mimicking a task entrypoint file: top-level code calls into the
// catalog (the same way `task()` / `schemaTask()` does via
// `registerTaskMetadata`).
//
// Loaded via `await import()` from inside a test that simulates the worker
// running a task. The point is to exercise top-level evaluation through Node's
// ESM module loader so the module-cache semantics are real.

const register = globalThis.__catalogRegisterTaskMetadata;
if (typeof register === "function") {
  register({
    id: "lazy-task",
    fns: {
      run: async () => "ok",
    },
  });
}

export const lazyTask = { id: "lazy-task" };
