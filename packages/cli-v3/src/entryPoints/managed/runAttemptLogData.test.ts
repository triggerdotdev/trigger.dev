import { describe, expect, it } from "vitest";
import { getWorkloadRunAttemptStartLogData } from "./runAttemptLogData.js";

describe("getWorkloadRunAttemptStartLogData", () => {
  it("omits environment variable values from the debug-log payload", () => {
    const start = {
      run: { friendlyId: "run_123" },
      snapshot: { friendlyId: "snapshot_123" },
      execution: { id: "execution_123" },
      envVars: { API_KEY: "secret-value" },
    };

    expect(getWorkloadRunAttemptStartLogData(start)).toEqual({
      run: start.run,
      snapshot: start.snapshot,
      execution: start.execution,
    });
  });
});
