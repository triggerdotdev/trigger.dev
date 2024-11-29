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
  const publicJwtEntityWithTaskWritePermissions: AuthorizationEntity = {
    type: "PUBLIC_JWT",
    scopes: ["write:tasks:task-1"],
  };

  describe("PRIVATE entity", () => {
    it("should always return authorized regardless of action or resource", () => {
      const result1 = checkAuthorization(privateEntity, "read", { runs: "run_1234" });
      expect(result1.authorized).toBe(true);
      expect(result1).not.toHaveProperty("reason");

      const result2 = checkAuthorization(privateEntity, "read", { tasks: ["task_1", "task_2"] });
      expect(result2.authorized).toBe(true);
      expect(result2).not.toHaveProperty("reason");

      const result3 = checkAuthorization(privateEntity, "read", { tags: "nonexistent_tag" });
      expect(result3.authorized).toBe(true);
      expect(result3).not.toHaveProperty("reason");
    });
  });

  describe("PUBLIC entity", () => {
    it("should always return unauthorized with reason regardless of action or resource", () => {
      const result1 = checkAuthorization(publicEntity, "read", { runs: "run_1234" });
      expect(result1.authorized).toBe(false);
      if (!result1.authorized) {
        expect(result1.reason).toBe("PUBLIC type is deprecated and has no access");
      }

      const result2 = checkAuthorization(publicEntity, "read", { tasks: ["task_1", "task_2"] });
      expect(result2.authorized).toBe(false);
      if (!result2.authorized) {
        expect(result2.reason).toBe("PUBLIC type is deprecated and has no access");
      }

      const result3 = checkAuthorization(publicEntity, "read", { tags: "tag_5678" });
      expect(result3.authorized).toBe(false);
      if (!result3.authorized) {
        expect(result3.reason).toBe("PUBLIC type is deprecated and has no access");
      }
    });
  });

  describe("PUBLIC_JWT entity with task write scope", () => {
    it("should return authorized for specific resource scope", () => {
      const result = checkAuthorization(publicJwtEntityWithTaskWritePermissions, "write", {
        tasks: "task-1",
      });
      expect(result.authorized).toBe(true);
      expect(result).not.toHaveProperty("reason");
    });

    it("should return unauthorized with reason for unauthorized specific resources", () => {
      const result = checkAuthorization(publicJwtEntityWithTaskWritePermissions, "write", {
        tasks: "task-2",
      });
      expect(result.authorized).toBe(false);
      if (!result.authorized) {
        expect(result.reason).toBe(
          "Public Access Token is missing required permissions. Token has the following permissions: 'write:tasks:task-1'. See https://trigger.dev/docs/frontend/overview#authentication for more information."
        );
      }
    });
  });

  describe("PUBLIC_JWT entity with scope", () => {
    it("should return authorized for specific resource scope", () => {
      const result = checkAuthorization(publicJwtEntityWithPermissions, "read", {
        runs: "run_1234",
      });
      expect(result.authorized).toBe(true);
      expect(result).not.toHaveProperty("reason");
    });

    it("should return unauthorized with reason for unauthorized specific resources", () => {
      const result = checkAuthorization(publicJwtEntityWithPermissions, "read", {
        runs: "run_5678",
      });
      expect(result.authorized).toBe(false);
      if (!result.authorized) {
        expect(result.reason).toBe(
          "Public Access Token is missing required permissions. Token has the following permissions: 'read:runs:run_1234', 'read:tasks', 'read:tags:tag_5678'. See https://trigger.dev/docs/frontend/overview#authentication for more information."
        );
      }
    });

    it("should return authorized for general resource type scope", () => {
      const result1 = checkAuthorization(publicJwtEntityWithPermissions, "read", {
        tasks: "task_1234",
      });
      expect(result1.authorized).toBe(true);
      expect(result1).not.toHaveProperty("reason");

      const result2 = checkAuthorization(publicJwtEntityWithPermissions, "read", {
        tasks: ["task_5678", "task_9012"],
      });
      expect(result2.authorized).toBe(true);
      expect(result2).not.toHaveProperty("reason");
    });

    it("should return authorized if any resource in an array is authorized", () => {
      const result = checkAuthorization(publicJwtEntityWithPermissions, "read", {
        tags: ["tag_1234", "tag_5678"],
      });
      expect(result.authorized).toBe(true);
      expect(result).not.toHaveProperty("reason");
    });

    it("should return authorized for nonexistent resource types", () => {
      const result = checkAuthorization(publicJwtEntityWithPermissions, "read", {
        // @ts-expect-error
        nonexistent: "resource",
      });
      expect(result.authorized).toBe(false);
      expect(result).toHaveProperty("reason");
    });
  });

  describe("PUBLIC_JWT entity without scope", () => {
    it("should always return unauthorized with reason regardless of action or resource", () => {
      const result1 = checkAuthorization(publicJwtEntityNoPermissions, "read", {
        runs: "run_1234",
      });
      expect(result1.authorized).toBe(false);
      if (!result1.authorized) {
        expect(result1.reason).toBe(
          "Public Access Token has no permissions. See https://trigger.dev/docs/frontend/overview#authentication for more information."
        );
      }

      const result2 = checkAuthorization(publicJwtEntityNoPermissions, "read", {
        tasks: ["task_1", "task_2"],
      });
      expect(result2.authorized).toBe(false);
      if (!result2.authorized) {
        expect(result2.reason).toBe(
          "Public Access Token has no permissions. See https://trigger.dev/docs/frontend/overview#authentication for more information."
        );
      }

      const result3 = checkAuthorization(publicJwtEntityNoPermissions, "read", {
        tags: "tag_5678",
      });
      expect(result3.authorized).toBe(false);
      if (!result3.authorized) {
        expect(result3.reason).toBe(
          "Public Access Token has no permissions. See https://trigger.dev/docs/frontend/overview#authentication for more information."
        );
      }
    });
  });

  describe("Edge cases", () => {
    it("should handle empty resource objects", () => {
      const result = checkAuthorization(publicJwtEntityWithPermissions, "read", {});
      expect(result.authorized).toBe(false);
      if (!result.authorized) {
        expect(result.reason).toBe("Resource object is empty");
      }
    });

    it("should handle undefined scope", () => {
      const entityUndefinedPermissions: AuthorizationEntity = { type: "PUBLIC_JWT" };
      const result = checkAuthorization(entityUndefinedPermissions, "read", { runs: "run_1234" });
      expect(result.authorized).toBe(false);
      if (!result.authorized) {
        expect(result.reason).toBe(
          "Public Access Token has no permissions. See https://trigger.dev/docs/frontend/overview#authentication for more information."
        );
      }
    });

    it("should handle empty scope array", () => {
      const entityEmptyPermissions: AuthorizationEntity = { type: "PUBLIC_JWT", scopes: [] };
      const result = checkAuthorization(entityEmptyPermissions, "read", { runs: "run_1234" });
      expect(result.authorized).toBe(false);
      if (!result.authorized) {
        expect(result.reason).toBe(
          "Public Access Token has no permissions. See https://trigger.dev/docs/frontend/overview#authentication for more information."
        );
      }
    });

    it("should return authorized if any resource is authorized", () => {
      const result = checkAuthorization(publicJwtEntityWithPermissions, "read", {
        runs: "run_1234", // This is authorized
        tasks: "task_5678", // This is authorized (general permission)
        tags: "tag_3456", // This is not authorized
      });
      expect(result.authorized).toBe(true);
      expect(result).not.toHaveProperty("reason");
    });

    it("should return unauthorized only if no resources are authorized", () => {
      const result = checkAuthorization(publicJwtEntityWithPermissions, "read", {
        runs: "run_5678", // Not authorized
        tags: "tag_3456", // Not authorized
      });
      expect(result.authorized).toBe(false);
      if (!result.authorized) {
        expect(result.reason).toContain("Public Access Token is missing required permissions");
      }
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
      const result1 = checkAuthorization(
        entityWithSuperPermissions,
        "read",
        { tasks: "task_1234" },
        ["read:all", "admin"]
      );
      expect(result1.authorized).toBe(true);
      expect(result1).not.toHaveProperty("reason");

      const result2 = checkAuthorization(
        entityWithSuperPermissions,
        "read",
        { tags: ["tag_1", "tag_2"] },
        ["write:all", "admin"]
      );
      expect(result2.authorized).toBe(true);
      expect(result2).not.toHaveProperty("reason");
    });

    it("should grant access with one matching super permission", () => {
      const result = checkAuthorization(
        entityWithOneSuperPermission,
        "read",
        { runs: "run_5678" },
        ["read:all", "admin"]
      );
      expect(result.authorized).toBe(true);
      expect(result).not.toHaveProperty("reason");
    });

    it("should not grant access when no super scope match", () => {
      const result = checkAuthorization(
        entityWithOneSuperPermission,
        "read",
        { tasks: "task_1234" },
        ["write:all", "admin"]
      );
      expect(result.authorized).toBe(false);
      if (!result.authorized) {
        expect(result.reason).toBe(
          "Public Access Token is missing required permissions. Token has the following permissions: 'read:all'. See https://trigger.dev/docs/frontend/overview#authentication for more information."
        );
      }
    });

    it("should grant access to multiple resources with super scope", () => {
      const result = checkAuthorization(
        entityWithSuperPermissions,
        "read",
        {
          tasks: "task_1234",
          tags: ["tag_1", "tag_2"],
          runs: "run_5678",
        },
        ["read:all"]
      );
      expect(result.authorized).toBe(true);
      expect(result).not.toHaveProperty("reason");
    });

    it("should fall back to specific scope when super scope are not provided", () => {
      const entityWithSpecificPermissions: AuthorizationEntity = {
        type: "PUBLIC_JWT",
        scopes: ["read:tasks", "read:tags"],
      };
      const result1 = checkAuthorization(entityWithSpecificPermissions, "read", {
        tasks: "task_1234",
      });
      expect(result1.authorized).toBe(true);
      expect(result1).not.toHaveProperty("reason");

      const result2 = checkAuthorization(entityWithSpecificPermissions, "read", {
        runs: "run_5678",
      });
      expect(result2.authorized).toBe(false);
      if (!result2.authorized) {
        expect(result2.reason).toBe(
          "Public Access Token is missing required permissions. Token has the following permissions: 'read:tasks', 'read:tags'. See https://trigger.dev/docs/frontend/overview#authentication for more information."
        );
      }
    });
  });

  describe("Without super scope", () => {
    const entityWithoutSuperPermissions: AuthorizationEntity = {
      type: "PUBLIC_JWT",
      scopes: ["read:tasks"],
    };

    it("should still grant access based on specific scope", () => {
      const result = checkAuthorization(
        entityWithoutSuperPermissions,
        "read",
        { tasks: "task_1234" },
        ["read:all", "admin"]
      );
      expect(result.authorized).toBe(true);
      expect(result).not.toHaveProperty("reason");
    });

    it("should deny access to resources not in scope", () => {
      const result = checkAuthorization(
        entityWithoutSuperPermissions,
        "read",
        { runs: "run_5678" },
        ["read:all", "admin"]
      );
      expect(result.authorized).toBe(false);
      if (!result.authorized) {
        expect(result.reason).toBe(
          "Public Access Token is missing required permissions. Token has the following permissions: 'read:tasks'. See https://trigger.dev/docs/frontend/overview#authentication for more information."
        );
      }
    });
  });
});
