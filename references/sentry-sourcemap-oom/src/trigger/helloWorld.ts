import { task } from "@trigger.dev/sdk";
// Import modules that simulate Sentry's debug ID injection
import { allModulesCount } from "../sentrySimulator/index.js";

/**
 * A simple task that runs successfully to verify the OOM fix works.
 *
 * The real test is whether the worker can load all the simulated
 * modules without running out of memory during the import phase.
 *
 * Before the fix, importing modules with Sentry's debug ID injection
 * (which accesses Error.stack during module loading) would cause OOM
 * on memory-constrained machines because source-map-support would
 * parse all sourcemaps synchronously.
 */
export const helloWorld = task({
  id: "sentry-oom-hello-world",
  run: async (payload: { message: string }) => {
    console.log(`Hello, ${payload.message}!`);
    console.log(`Loaded ${allModulesCount} simulated modules with debug ID injection`);
    return {
      success: true,
      message: payload.message,
      modulesLoaded: allModulesCount,
    };
  },
});
