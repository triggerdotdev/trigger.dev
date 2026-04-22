import { describe, it, expect } from "vitest";
import { permissiveAbility, superAbility, denyAbility, buildFallbackAbility } from "./ability.js";

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
