import type { RbacAbility } from "@trigger.dev/plugins";
import { describe, expect, it } from "vitest";
import { buildJwtAbility } from "./ability.js";
import { withActionAliases } from "./index.js";

describe("withActionAliases", () => {
  it("direct action match passes through unchanged", () => {
    const ability = withActionAliases(buildJwtAbility(["write:tasks"]));
    expect(ability.can("write", { type: "tasks", id: "task_x" })).toBe(true);
  });

  it("trigger action is satisfied by a write:tasks scope (alias retry)", () => {
    const ability = withActionAliases(buildJwtAbility(["write:tasks"]));
    expect(ability.can("trigger", { type: "tasks", id: "task_x" })).toBe(true);
  });

  it("batchTrigger action is satisfied by a write:tasks scope (alias retry)", () => {
    const ability = withActionAliases(buildJwtAbility(["write:tasks"]));
    expect(ability.can("batchTrigger", { type: "tasks", id: "task_x" })).toBe(true);
  });

  it("update action is satisfied by a write:prompts scope (alias retry)", () => {
    const ability = withActionAliases(buildJwtAbility(["write:prompts"]));
    expect(ability.can("update", { type: "prompts", id: "p_x" })).toBe(true);
  });

  it("id-scoped write scope satisfies the aliased action on matching id", () => {
    const ability = withActionAliases(buildJwtAbility(["write:tasks:task_x"]));
    expect(ability.can("trigger", { type: "tasks", id: "task_x" })).toBe(true);
  });

  it("id-scoped write scope denies the aliased action on a different id", () => {
    const ability = withActionAliases(buildJwtAbility(["write:tasks:task_x"]));
    expect(ability.can("trigger", { type: "tasks", id: "task_other" })).toBe(false);
  });

  it("read scope does not satisfy a trigger action (aliases are write-only)", () => {
    const ability = withActionAliases(buildJwtAbility(["read:tasks"]));
    expect(ability.can("trigger", { type: "tasks", id: "task_x" })).toBe(false);
  });

  it("non-aliased custom action only matches its direct action scope", () => {
    const ability = withActionAliases(buildJwtAbility(["read:runs"]));
    expect(ability.can("someOtherAction", { type: "runs", id: "run_x" })).toBe(false);
  });

  it("admin scope continues to grant everything regardless of aliases", () => {
    const ability = withActionAliases(buildJwtAbility(["admin"]));
    expect(ability.can("trigger", { type: "tasks", id: "task_x" })).toBe(true);
    expect(ability.can("batchTrigger", { type: "tasks", id: "task_x" })).toBe(true);
    expect(ability.can("anything", { type: "whatever", id: "x" })).toBe(true);
  });

  it("array resource form: alias retry applies when any element passes", () => {
    const ability = withActionAliases(buildJwtAbility(["write:tasks:task_x"]));
    const resources = [
      { type: "tasks", id: "task_other" },
      { type: "tasks", id: "task_x" },
    ];
    expect(ability.can("trigger", resources)).toBe(true);
  });

  it("canSuper is delegated unchanged", () => {
    const allowSuper: RbacAbility = { can: () => false, canSuper: () => true };
    const denySuper: RbacAbility = { can: () => false, canSuper: () => false };
    expect(withActionAliases(allowSuper).canSuper()).toBe(true);
    expect(withActionAliases(denySuper).canSuper()).toBe(false);
  });
});
