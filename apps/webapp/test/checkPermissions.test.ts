import { describe, it, expect } from "vitest";
import type { RbacAbility } from "@trigger.dev/rbac";
import { checkPermissions } from "~/services/routeBuilders/permissions.server";

const permissive: RbacAbility = { can: () => true, canSuper: () => false };
const denyAll: RbacAbility = { can: () => false, canSuper: () => false };

describe("checkPermissions", () => {
  it("returns true for every check under a permissive ability (OSS path)", () => {
    const result = checkPermissions(permissive, {
      canCancelRun: { action: "write", resource: { type: "runs" } },
      canManageMembers: { action: "manage", resource: { type: "members" } },
    });

    expect(result).toEqual({ canCancelRun: true, canManageMembers: true });
  });

  it("returns false for every check under a deny-all ability", () => {
    const result = checkPermissions(denyAll, {
      canCancelRun: { action: "write", resource: { type: "runs" } },
    });

    expect(result).toEqual({ canCancelRun: false });
  });

  it("evaluates each check independently against can()", () => {
    const ability: RbacAbility = {
      can: (action, resource) => {
        const r = Array.isArray(resource) ? resource[0] : resource;
        return action === "read" || r.type === "tasks";
      },
      canSuper: () => false,
    };

    const result = checkPermissions(ability, {
      readRuns: { action: "read", resource: { type: "runs" } },
      writeRuns: { action: "write", resource: { type: "runs" } },
      writeTasks: { action: "write", resource: { type: "tasks" } },
    });

    expect(result).toEqual({ readRuns: true, writeRuns: false, writeTasks: true });
  });

  it("supports requireSuper checks via canSuper()", () => {
    const admin: RbacAbility = { can: () => false, canSuper: () => true };

    expect(checkPermissions(admin, { adminOnly: { requireSuper: true } })).toEqual({
      adminOnly: true,
    });
    expect(checkPermissions(denyAll, { adminOnly: { requireSuper: true } })).toEqual({
      adminOnly: false,
    });
  });

  it("passes resource arrays straight through to can()", () => {
    const seen: unknown[] = [];
    const ability: RbacAbility = {
      can: (_action, resource) => {
        seen.push(resource);
        return true;
      },
      canSuper: () => false,
    };

    checkPermissions(ability, {
      x: { action: "read", resource: [{ type: "runs" }, { type: "tasks" }] },
    });

    expect(seen[0]).toEqual([{ type: "runs" }, { type: "tasks" }]);
  });
});
