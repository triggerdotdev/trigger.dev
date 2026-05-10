import { describe, it, expect } from "vitest";
import { permissiveAbility, superAbility, denyAbility, buildFallbackAbility, buildJwtAbility } from "./ability.js";

describe("permissiveAbility", () => {
  it("allows any action on any resource type", () => {
    expect(permissiveAbility.can("read", { type: "run" })).toBe(true);
    expect(permissiveAbility.can("write", { type: "deployment" })).toBe(true);
    expect(permissiveAbility.can("delete", { type: "task" })).toBe(true);
  });

  it("allows actions on specific resource instances", () => {
    expect(permissiveAbility.can("read", { type: "run", id: "run_abc123" })).toBe(true);
  });

  it("does not grant super-user access", () => {
    expect(permissiveAbility.canSuper()).toBe(false);
  });
});

describe("superAbility", () => {
  it("allows any action on any resource", () => {
    expect(superAbility.can("read", { type: "run" })).toBe(true);
    expect(superAbility.can("write", { type: "deployment" })).toBe(true);
  });

  it("grants super-user access", () => {
    expect(superAbility.canSuper()).toBe(true);
  });
});

describe("denyAbility", () => {
  it("denies all actions", () => {
    expect(denyAbility.can("read", { type: "run" })).toBe(false);
    expect(denyAbility.can("write", { type: "deployment" })).toBe(false);
  });

  it("does not grant super-user access", () => {
    expect(denyAbility.canSuper()).toBe(false);
  });
});

describe("buildJwtAbility", () => {
  it("allows action matching a general scope", () => {
    const ability = buildJwtAbility(["read:runs"]);
    expect(ability.can("read", { type: "runs" })).toBe(true);
    expect(ability.can("read", { type: "runs", id: "run_abc" })).toBe(true);
  });

  it("allows only the specific ID for a scoped permission", () => {
    const ability = buildJwtAbility(["read:runs:run_abc"]);
    expect(ability.can("read", { type: "runs", id: "run_abc" })).toBe(true);
    expect(ability.can("read", { type: "runs", id: "run_xyz" })).toBe(false);
    expect(ability.can("read", { type: "runs" })).toBe(false);
  });

  it("preserves colons in the resource id (everything after the 2nd colon)", () => {
    // Resource ids can contain colons (e.g. user-provided tags like
    // `env:staging`). The naive `[a, b, c] = scope.split(":")` form
    // truncated `read:tags:env:staging` → scopeId="env" and silently
    // mis-matched. Regression coverage for the multi-colon id path.
    const ability = buildJwtAbility(["read:tags:env:staging"]);
    expect(ability.can("read", { type: "tags", id: "env:staging" })).toBe(true);
    expect(ability.can("read", { type: "tags", id: "env" })).toBe(false);
    expect(ability.can("read", { type: "tags", id: "env:prod" })).toBe(false);
  });

  it("allows any read with read:all scope", () => {
    const ability = buildJwtAbility(["read:all"]);
    expect(ability.can("read", { type: "runs" })).toBe(true);
    expect(ability.can("read", { type: "tasks" })).toBe(true);
    expect(ability.can("write", { type: "runs" })).toBe(false);
  });

  it("allows everything with admin scope", () => {
    const ability = buildJwtAbility(["admin"]);
    expect(ability.can("read", { type: "runs" })).toBe(true);
    expect(ability.can("write", { type: "deployments" })).toBe(true);
  });

  // Pre-RBAC, the legacy checkAuthorization string-matched superScopes;
  // a scope `admin:sessions` only granted access to routes that
  // explicitly listed it. After the JWT-ability split we must not let
  // `admin:<anything>` act as a universal wildcard — it should grant
  // only the `admin` action against resources of that type.
  it("admin:<type> is not a universal wildcard", () => {
    const ability = buildJwtAbility(["admin:sessions"]);
    expect(ability.can("read", { type: "runs" })).toBe(false);
    expect(ability.can("write", { type: "tasks" })).toBe(false);
    expect(ability.can("admin", { type: "runs" })).toBe(false);
    // But it does grant the admin action on its own type.
    expect(ability.can("admin", { type: "sessions" })).toBe(true);
    expect(ability.can("admin", { type: "sessions", id: "ses_abc" })).toBe(true);
  });

  it("admin:<type>:<id> grants admin action only on that exact resource", () => {
    const ability = buildJwtAbility(["admin:sessions:ses_abc"]);
    expect(ability.can("admin", { type: "sessions", id: "ses_abc" })).toBe(true);
    expect(ability.can("admin", { type: "sessions", id: "ses_xyz" })).toBe(false);
    expect(ability.can("admin", { type: "runs" })).toBe(false);
    expect(ability.can("read", { type: "sessions", id: "ses_abc" })).toBe(false);
  });

  it("never grants canSuper", () => {
    expect(buildJwtAbility(["admin"]).canSuper()).toBe(false);
    expect(buildJwtAbility(["read:all"]).canSuper()).toBe(false);
    expect(buildJwtAbility([]).canSuper()).toBe(false);
  });

  it("denies everything for empty scopes", () => {
    const ability = buildJwtAbility([]);
    expect(ability.can("read", { type: "runs" })).toBe(false);
  });

  it("denies wrong action with general resource scope", () => {
    const ability = buildJwtAbility(["read:runs"]);
    expect(ability.can("write", { type: "runs" })).toBe(false);
  });
});

describe("buildJwtAbility — array resources", () => {
  it("authorizes when any resource in the array passes a scope check", () => {
    const ability = buildJwtAbility(["read:batch:batch_abc"]);
    const resources = [
      { type: "runs", id: "run_xyz" },
      { type: "batch", id: "batch_abc" },
      { type: "tasks", id: "task_other" },
    ];
    expect(ability.can("read", resources)).toBe(true);
  });

  it("rejects when no resource in the array passes a scope check", () => {
    const ability = buildJwtAbility(["read:batch:batch_abc"]);
    const resources = [
      { type: "runs", id: "run_xyz" },
      { type: "batch", id: "batch_other" },
      { type: "tasks", id: "task_other" },
    ];
    expect(ability.can("read", resources)).toBe(false);
  });

  it("empty array never authorizes", () => {
    const ability = buildJwtAbility(["read:all"]);
    expect(ability.can("read", [])).toBe(false);
  });

  it("authorizes a single resource via the non-array form (backwards compatible)", () => {
    const ability = buildJwtAbility(["read:runs:run_abc"]);
    expect(ability.can("read", { type: "runs", id: "run_abc" })).toBe(true);
  });
});

describe("buildFallbackAbility", () => {
  it("returns permissiveAbility for non-admin users", () => {
    const ability = buildFallbackAbility(false);
    expect(ability.can("read", { type: "run" })).toBe(true);
    expect(ability.canSuper()).toBe(false);
  });

  it("returns superAbility for admin users", () => {
    const ability = buildFallbackAbility(true);
    expect(ability.can("read", { type: "run" })).toBe(true);
    expect(ability.canSuper()).toBe(true);
  });
});
