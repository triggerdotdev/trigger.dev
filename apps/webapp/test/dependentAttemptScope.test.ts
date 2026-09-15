import { describe, expect, it } from "vitest";
import { dependentAttemptWhere } from "../app/v3/services/dependentAttemptScope.js";

// The dependent-attempt lookup must be scoped to the caller's environment via
// the related run — a where clause missing that constraint lets a foreign
// attempt friendlyId resolve (the cross-tenant bug). This pins the scope on the
// query itself.
describe("dependentAttemptWhere", () => {
  it("scopes the attempt lookup to the environment via the related run", () => {
    const where = dependentAttemptWhere("attempt_abc", "env_caller");
    expect(where.friendlyId).toBe("attempt_abc");
    expect(where.taskRun).toEqual({ runtimeEnvironmentId: "env_caller" });
  });

  it("threads the exact environment id through (no cross-env match)", () => {
    const where = dependentAttemptWhere("attempt_abc", "env_A");
    // The env constraint must reference the caller's env, not be absent/empty.
    expect((where.taskRun as { runtimeEnvironmentId?: string })?.runtimeEnvironmentId).toBe(
      "env_A"
    );
  });
});
