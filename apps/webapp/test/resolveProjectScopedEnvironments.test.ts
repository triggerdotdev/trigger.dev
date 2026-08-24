import { describe, expect, it } from "vitest";
import { resolveProjectScopedEnvironments } from "../app/v3/services/resolveProjectScopedEnvironments.js";

const projectEnvs = [{ id: "env_prod" }, { id: "env_staging" }, { id: "env_dev" }];

// A submitted environment id that doesn't belong to the project must be
// rejected, not silently dropped.
describe("resolveProjectScopedEnvironments", () => {
  it("resolves ids that all belong to the project", () => {
    const r = resolveProjectScopedEnvironments(["env_prod", "env_dev"], projectEnvs);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.environments.map((e) => e.id)).toEqual(["env_prod", "env_dev"]);
  });

  it("rejects a foreign environment id (the cross-tenant vector)", () => {
    const r = resolveProjectScopedEnvironments(["env_someone_elses"], projectEnvs);
    expect(r.kind).toBe("foreign");
    if (r.kind === "foreign") expect(r.foreignEnvironmentId).toBe("env_someone_elses");
  });

  it("rejects when a foreign id is mixed in with valid ones (not silently dropped)", () => {
    const r = resolveProjectScopedEnvironments(["env_prod", "env_foreign"], projectEnvs);
    expect(r.kind).toBe("foreign");
    if (r.kind === "foreign") expect(r.foreignEnvironmentId).toBe("env_foreign");
  });

  it("returns an empty set for no ids", () => {
    const r = resolveProjectScopedEnvironments([], projectEnvs);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.environments).toEqual([]);
  });

  it("rejects an empty-string id rather than dropping it (falsy edge case)", () => {
    const r = resolveProjectScopedEnvironments([""], projectEnvs);
    expect(r.kind).toBe("foreign");
    if (r.kind === "foreign") expect(r.foreignEnvironmentId).toBe("");
  });

  it("rejects an empty-string id mixed in with valid ids", () => {
    const r = resolveProjectScopedEnvironments(["env_prod", ""], projectEnvs);
    expect(r.kind).toBe("foreign");
    if (r.kind === "foreign") expect(r.foreignEnvironmentId).toBe("");
  });
});
