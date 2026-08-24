import { describe, expect, it, vi } from "vitest";
import { logBuildWorkerStart } from "./buildWorkerLogging.js";
import { logger } from "../utilities/logger.js";

const secret = "build-worker-secret-value";

describe("logBuildWorkerStart", () => {
  it.each(["deploy", "unmanaged"] as const)(
    "does not log environment values for %s builds",
    (target) => {
      const debug = vi.spyOn(logger, "debug").mockImplementation(() => {});

      logBuildWorkerStart({
        target,
        branch: "main",
        envVars: { BUILD_SECRET: secret },
        rewritePaths: true,
        forcedExternals: ["example-package"],
      });

      expect(debug).toHaveBeenCalledOnce();
      expect(JSON.stringify(debug.mock.calls)).not.toContain(secret);
      expect(debug).toHaveBeenCalledWith("Starting buildWorker", {
        target,
        hasBranch: true,
        envVarCount: 1,
        rewritePaths: true,
        forcedExternalsCount: 1,
        plain: false,
      });

      debug.mockRestore();
    }
  );
});
