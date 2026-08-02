import { type RuntimeEnvironmentType } from "@trigger.dev/database";

type AccessibleEnvironmentInput = {
  type: RuntimeEnvironmentType;
  orgMember: { userId: string } | null;
};

/**
 * The first environment the user may actually use. Development environments are
 * per-member, so resolving one by slug or stored id alone can return another
 * member's; every other type is shared by the project.
 */
export function selectAccessibleEnvironment<T extends AccessibleEnvironmentInput>(
  environments: T[],
  userId: string
): T | undefined {
  return environments.find(
    (environment) => environment.type !== "DEVELOPMENT" || environment.orgMember?.userId === userId
  );
}
