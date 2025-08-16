export type AuthorizationAction = "read" | "write" | string; // Add more actions as needed

const ResourceTypes = ["tasks", "tags", "runs", "batch", "waitpoints", "deployments"] as const;

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
export type AuthorizationResult = { authorized: true } | { authorized: false; reason: string };

/**
 * Checks if the given entity is authorized to perform a specific action on a resource.
 */
export function checkAuthorization(
  entity: AuthorizationEntity,
  action: AuthorizationAction,
  resource: AuthorizationResources,
  superScopes?: string[]
): AuthorizationResult {
  // "PRIVATE" is a secret key and has access to everything
  if (entity.type === "PRIVATE") {
    return { authorized: true };
  }

  // "PUBLIC" is a deprecated key and has no access
  if (entity.type === "PUBLIC") {
    return { authorized: false, reason: "PUBLIC type is deprecated and has no access" };
  }

  // If the entity has no permissions, deny access
  if (!entity.scopes || entity.scopes.length === 0) {
    return {
      authorized: false,
      reason:
        "Public Access Token has no permissions. See https://trigger.dev/docs/frontend/overview#authentication for more information.",
    };
  }

  // If the resource object is empty, deny access
  if (Object.keys(resource).length === 0) {
    return { authorized: false, reason: "Resource object is empty" };
  }

  // Check for any of the super scopes
  if (superScopes && superScopes.length > 0) {
    if (superScopes.some((permission) => entity.scopes?.includes(permission))) {
      return { authorized: true };
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

    for (const value of resourceValues) {
      // Check for specific resource permission
      const specificPermission = `${action}:${resourceType}:${value}`;
      // Check for general resource type permission
      const generalPermission = `${action}:${resourceType}`;

      // If any permission matches, return authorized
      if (entity.scopes.includes(specificPermission) || entity.scopes.includes(generalPermission)) {
        return { authorized: true };
      }
    }
  }

  // No matching permissions found
  return {
    authorized: false,
    reason: `Public Access Token is missing required permissions. Token has the following permissions: ${entity.scopes
      .map((s) => `'${s}'`)
      .join(
        ", "
      )}. See https://trigger.dev/docs/frontend/overview#authentication for more information.`,
  };
}
