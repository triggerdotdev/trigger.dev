import { describe, expect, it } from "vitest";
import {
  attemptInEnvironmentWhere,
  batchRunInEnvironmentWhere,
} from "../app/v3/services/triggerV1Scoping.js";

// Caller-supplied parent/dependent attempt & batch friendlyIds must be resolved
// scoped to the caller's environment — a where clause missing that constraint
// lets a foreign id resolve (the cross-tenant bug). Pins the scope on each query.
describe("triggerV1 scoping where-clauses", () => {
  it("scopes attempt lookups to the env via the related run", () => {
    const where = attemptInEnvironmentWhere("attempt_x", "env_caller");
    expect(where.friendlyId).toBe("attempt_x");
    expect(where.taskRun).toEqual({ runtimeEnvironmentId: "env_caller" });
  });

  it("scopes batch-run lookups to the env directly", () => {
    const where = batchRunInEnvironmentWhere("batch_x", "env_caller");
    expect(where.friendlyId).toBe("batch_x");
    expect(where.runtimeEnvironmentId).toBe("env_caller");
  });
});
