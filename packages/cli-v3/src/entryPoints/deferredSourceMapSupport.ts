import sourceMapSupport from "source-map-support";

/**
 * Phase-based deferred sourcemap parsing to prevent OOM during module loading.
 *
 * **Problem:** Sentry's debug ID injection (`sentry-cli sourcemaps inject`) adds
 * `new Error().stack` calls to every bundled `.mjs` file. When `source-map-support`
 * is installed, every `.stack` access triggers sourcemap parsing. This causes all
 * sourcemaps to be parsed synchronously during the import phase, leading to OOM
 * before any task code runs.
 *
 * **Solution:** Skip sourcemap parsing during module loading phase. Once bootstrap
 * completes and the worker is ready to execute tasks, enable sourcemap support.
 *
 * **Trade-off:** Import errors won't have source-mapped stack traces, but they
 * already have good bundler messages. Runtime errors during task execution will
 * still have full sourcemap support.
 */

let _isLoadingPhase = true;

/**
 * Install source-map-support with deferred parsing.
 *
 * During the loading phase, sourcemap retrieval is skipped to avoid OOM
 * from tools like Sentry that access Error.stack during module loading.
 * Call `enableSourceMapSupport()` after bootstrap completes to enable
 * sourcemap parsing for actual runtime errors.
 */
export function installDeferredSourceMapSupport() {
  sourceMapSupport.install({
    handleUncaughtExceptions: false,
    environment: "node",
    hookRequire: false,
    retrieveSourceMap: (source) => {
      // During loading phase, skip sourcemap parsing to avoid OOM
      if (_isLoadingPhase) {
        return null;
      }
      // Return undefined to use default sourcemap retrieval behavior
      return undefined as any;
    },
  });
}

/**
 * Enable sourcemap support after the loading phase completes.
 *
 * Call this after bootstrap() completes and before task execution begins.
 * This ensures that runtime errors during task execution have proper
 * source-mapped stack traces.
 */
export function enableSourceMapSupport() {
  _isLoadingPhase = false;
}

/**
 * Check if we're still in the loading phase.
 */
export function isLoadingPhase() {
  return _isLoadingPhase;
}
