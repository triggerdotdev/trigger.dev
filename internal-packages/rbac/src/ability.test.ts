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
