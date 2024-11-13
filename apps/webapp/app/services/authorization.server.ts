export type AuthorizationAction = "read" | "write"; // Add more actions as needed

const ResourceTypes = ["tasks", "tags", "runs", "batch"] as const;

export type AuthorizationResources = {
  [key in (typeof ResourceTypes)[number]]?: string | string[];
};

export type AuthorizationEntity = {
  type: "PUBLIC" | "PRIVATE" | "PUBLIC_JWT";
  scopes?: string[];
};

/**
 * Checks if the given entity is authorized to perform a specific action on a resource.
 *
 * @param entity - The entity requesting authorization.
 * @param action - The action the entity wants to perform.
 * @param resource - The resource on which the action is to be performed.
 * @param superScopes - An array of super scopes that can bypass the normal authorization checks.
 *
 * @example
 *
 * ```typescript
 * import { checkAuthorization } from "./authorization.server";
 *
 * const entity = {
 *  type: "PUBLIC",
 *  scope: ["read:runs:run_1234", "read:tasks"]
 * };
 *
 * checkAuthorization(entity, "read", { runs: "run_1234" }); // Returns true
 * checkAuthorization(entity, "read", { runs: "run_5678" }); // Returns false
 * checkAuthorization(entity, "read", { tasks: "task_1234" }); // Returns true
 * checkAuthorization(entity, "read", { tasks: ["task_5678"] }); // Returns true
 * ```
 */
export function checkAuthorization(
  entity: AuthorizationEntity,
  action: AuthorizationAction,
  resource: AuthorizationResources,
  superScopes?: string[]
) {
  // "PRIVATE" is a secret key and has access to everything
  if (entity.type === "PRIVATE") {
    return true;
  }

  // "PUBLIC" is a deprecated key and has no access
  if (entity.type === "PUBLIC") {
    return false;
  }

  // If the entity has no permissions, deny access
  if (!entity.scopes || entity.scopes.length === 0) {
    return false;
  }

  // If the resource object is empty, deny access
  if (Object.keys(resource).length === 0) {
    return false;
  }

  // Check for any of the super scopes
  if (superScopes && superScopes.length > 0) {
    if (superScopes.some((permission) => entity.scopes?.includes(permission))) {
      return true;
    }
  }

  const filteredResource = Object.keys(resource).reduce((acc, key) => {
    if (ResourceTypes.includes(key)) {
      acc[key as keyof AuthorizationResources] = resource[key as keyof AuthorizationResources];
    }
    return acc;
  }, {} as AuthorizationResources);

  // Check each resource type
  for (const [resourceType, resourceValue] of Object.entries(filteredResource)) {
    const resourceValues = Array.isArray(resourceValue) ? resourceValue : [resourceValue];

    let resourceAuthorized = false;
    for (const value of resourceValues) {
      // Check for specific resource permission
      const specificPermission = `${action}:${resourceType}:${value}`;
      // Check for general resource type permission
      const generalPermission = `${action}:${resourceType}`;

      if (entity.scopes.includes(specificPermission) || entity.scopes.includes(generalPermission)) {
        resourceAuthorized = true;
        break;
      }
    }

    // If any resource is not authorized, return false
    if (!resourceAuthorized) {
      return false;
    }
  }

  // All resources are authorized
  return true;
}
