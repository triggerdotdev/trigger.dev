import { describe, it, expect } from "vitest";
import { checkAuthorization, AuthorizationEntity } from "../app/services/authorization.server";

describe("checkAuthorization", () => {
  // Test entities
  const privateEntity: AuthorizationEntity = { type: "PRIVATE" };
  const publicEntity: AuthorizationEntity = { type: "PUBLIC" };
  const publicJwtEntityWithPermissions: AuthorizationEntity = {
    type: "PUBLIC_JWT",
    scopes: ["read:runs:run_1234", "read:tasks", "read:tags:tag_5678"],
  };
  const publicJwtEntityNoPermissions: AuthorizationEntity = { type: "PUBLIC_JWT" };

  describe("PRIVATE entity", () => {
    it("should always return true regardless of action or resource", () => {
      expect(checkAuthorization(privateEntity, "read", { runs: "run_1234" })).toBe(true);
      expect(checkAuthorization(privateEntity, "read", { tasks: ["task_1", "task_2"] })).toBe(true);
      expect(checkAuthorization(privateEntity, "read", { tags: "nonexistent_tag" })).toBe(true);
    });
  });

  describe("PUBLIC entity", () => {
    it("should always return false regardless of action or resource", () => {
      expect(checkAuthorization(publicEntity, "read", { runs: "run_1234" })).toBe(false);
      expect(checkAuthorization(publicEntity, "read", { tasks: ["task_1", "task_2"] })).toBe(false);
      expect(checkAuthorization(publicEntity, "read", { tags: "tag_5678" })).toBe(false);
    });
  });

  describe("PUBLIC_JWT entity with scope", () => {
    it("should return true for specific resource scope", () => {
      expect(checkAuthorization(publicJwtEntityWithPermissions, "read", { runs: "run_1234" })).toBe(
        true
      );
    });

    it("should return false for unauthorized specific resources", () => {
      expect(checkAuthorization(publicJwtEntityWithPermissions, "read", { runs: "run_5678" })).toBe(
        false
      );
    });

    it("should return true for general resource type scope", () => {
      expect(
        checkAuthorization(publicJwtEntityWithPermissions, "read", { tasks: "task_1234" })
      ).toBe(true);
      expect(
        checkAuthorization(publicJwtEntityWithPermissions, "read", {
          tasks: ["task_5678", "task_9012"],
        })
      ).toBe(true);
    });

    it("should return true if any resource in an array is authorized", () => {
      expect(
        checkAuthorization(publicJwtEntityWithPermissions, "read", {
          tags: ["tag_1234", "tag_5678"],
        })
      ).toBe(true);
    });

    it("should return true for nonexistent resource types", () => {
      expect(
        // @ts-expect-error
        checkAuthorization(publicJwtEntityWithPermissions, "read", { nonexistent: "resource" })
      ).toBe(true);
    });
  });

  describe("PUBLIC_JWT entity without scope", () => {
    it("should always return false regardless of action or resource", () => {
      expect(checkAuthorization(publicJwtEntityNoPermissions, "read", { runs: "run_1234" })).toBe(
        false
      );
      expect(
        checkAuthorization(publicJwtEntityNoPermissions, "read", { tasks: ["task_1", "task_2"] })
      ).toBe(false);
      expect(checkAuthorization(publicJwtEntityNoPermissions, "read", { tags: "tag_5678" })).toBe(
        false
      );
    });
  });

  describe("Edge cases", () => {
    it("should handle empty resource objects", () => {
      expect(checkAuthorization(publicJwtEntityWithPermissions, "read", {})).toBe(false);
    });

    it("should handle undefined scope", () => {
      const entityUndefinedPermissions: AuthorizationEntity = { type: "PUBLIC_JWT" };
      expect(checkAuthorization(entityUndefinedPermissions, "read", { runs: "run_1234" })).toBe(
        false
      );
    });

    it("should handle empty scope array", () => {
      const entityEmptyPermissions: AuthorizationEntity = { type: "PUBLIC_JWT", scopes: [] };
      expect(checkAuthorization(entityEmptyPermissions, "read", { runs: "run_1234" })).toBe(false);
    });

    it("should return false if any resource is not authorized", () => {
      expect(
        checkAuthorization(publicJwtEntityWithPermissions, "read", {
          runs: "run_1234", // This is authorized
          tasks: "task_5678", // This is authorized (general permission)
          tags: "tag_3456", // This is not authorized
        })
      ).toBe(false);
    });

    it("should return true only if all resources are authorized", () => {
      expect(
        checkAuthorization(publicJwtEntityWithPermissions, "read", {
          runs: "run_1234", // This is authorized
          tasks: "task_5678", // This is authorized (general permission)
          tags: "tag_5678", // This is authorized
        })
      ).toBe(true);
    });
  });

  describe("Super scope", () => {
    const entityWithSuperPermissions: AuthorizationEntity = {
      type: "PUBLIC_JWT",
      scopes: ["read:all", "admin"],
    };

    const entityWithOneSuperPermission: AuthorizationEntity = {
      type: "PUBLIC_JWT",
      scopes: ["read:all"],
    };

    it("should grant access with any of the super scope", () => {
      expect(
        checkAuthorization(entityWithSuperPermissions, "read", { tasks: "task_1234" }, [
          "read:all",
          "admin",
        ])
      ).toBe(true);
      expect(
        checkAuthorization(entityWithSuperPermissions, "read", { tags: ["tag_1", "tag_2"] }, [
          "write:all",
          "admin",
        ])
      ).toBe(true);
    });

    it("should grant access with one matching super permission", () => {
      expect(
        checkAuthorization(entityWithOneSuperPermission, "read", { runs: "run_5678" }, [
          "read:all",
          "admin",
        ])
      ).toBe(true);
    });

    it("should not grant access when no super scope match", () => {
      expect(
        checkAuthorization(entityWithOneSuperPermission, "read", { tasks: "task_1234" }, [
          "write:all",
          "admin",
        ])
      ).toBe(false);
    });

    it("should grant access to multiple resources with super scope", () => {
      expect(
        checkAuthorization(
          entityWithSuperPermissions,
          "read",
          {
            tasks: "task_1234",
            tags: ["tag_1", "tag_2"],
            runs: "run_5678",
          },
          ["read:all"]
        )
      ).toBe(true);
    });

    it("should fall back to specific scope when super scope are not provided", () => {
      const entityWithSpecificPermissions: AuthorizationEntity = {
        type: "PUBLIC_JWT",
        scopes: ["read:tasks", "read:tags"],
      };
      expect(
        checkAuthorization(entityWithSpecificPermissions, "read", { tasks: "task_1234" })
      ).toBe(true);
      expect(checkAuthorization(entityWithSpecificPermissions, "read", { runs: "run_5678" })).toBe(
        false
      );
    });
  });

  describe("Without super scope", () => {
    const entityWithoutSuperPermissions: AuthorizationEntity = {
      type: "PUBLIC_JWT",
      scopes: ["read:tasks"],
    };

    it("should still grant access based on specific scope", () => {
      expect(
        checkAuthorization(entityWithoutSuperPermissions, "read", { tasks: "task_1234" }, [
          "read:all",
          "admin",
        ])
      ).toBe(true);
    });

    it("should deny access to resources not in scope", () => {
      expect(
        checkAuthorization(entityWithoutSuperPermissions, "read", { runs: "run_5678" }, [
          "read:all",
          "admin",
        ])
      ).toBe(false);
    });
  });
});
