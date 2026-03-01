import sourceMapSupport from "source-map-support";

/**
 * Installs source-map-support with a workaround for Bun's source map handling.
 *
 * Bun's runtime can produce source maps with column values of -1, which causes
 * source-map@0.6.1 (used by source-map-support) to throw:
 * "Column must be greater than or equal to 0, got -1"
 *
 * This wraps the prepareStackTrace hook so that if source map processing fails,
 * it falls back to default stack trace formatting instead of crashing.
 *
 * See: https://github.com/oven-sh/bun/issues/8087
 */
export function installSourceMapSupport() {
  sourceMapSupport.install({
    handleUncaughtExceptions: false,
    environment: "node",
    hookRequire: false,
  });

  const _prepareStackTrace = (Error as any).prepareStackTrace;
  if (_prepareStackTrace) {
    (Error as any).prepareStackTrace = (error: Error, stackTraces: NodeJS.CallSite[]) => {
      try {
        return _prepareStackTrace(error, stackTraces);
      } catch {
        return `${error}\n` + stackTraces.map((s) => `    at ${s}`).join("\n");
      }
    };
  }
}
