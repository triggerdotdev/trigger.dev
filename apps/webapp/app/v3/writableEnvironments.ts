// Which environments a user may write env vars to. Shared env types
// (preview/staging/production) are writable by any project member; DEVELOPMENT
// environments are per-user and only writable by their owner.

export type WriteCheckEnvironment = {
  id: string;
  type: string;
  orgMember: { userId: string } | null;
};

const SHARED_ENV_TYPES = new Set(["PREVIEW", "STAGING", "PRODUCTION"]);

/**
 * Return the first submitted id the user may NOT write to — either it isn't one
 * of the project's environments or it's a DEV env owned by someone else.
 * Returns null when every submitted id is writable by `userId`.
 */
export function findUnauthorizedEnvironmentId(
  projectEnvironments: ReadonlyArray<WriteCheckEnvironment>,
  submittedIds: ReadonlyArray<string>,
  userId: string
): string | null {
  const byId = new Map(projectEnvironments.map((e) => [e.id, e]));
  for (const id of submittedIds) {
    const env = byId.get(id);
    if (!env) return id;
    const writable =
      SHARED_ENV_TYPES.has(env.type) ||
      (env.type === "DEVELOPMENT" && env.orgMember?.userId === userId);
    if (!writable) return id;
  }
  return null;
}

export type RefusedEnvironment<E extends WriteCheckEnvironment> =
  /** Not one of the project's environments, or an archived one. */
  | { id: string; reason: "notFound" }
  /** The role can't write environment variables of this environment type. */
  | { id: string; reason: "noPermission"; environment: E }
  /** A DEV environment owned by someone else. */
  | { id: string; reason: "notOwner"; environment: E };

/**
 * Every submitted environment id the user may NOT write to, with why, for a write that names
 * several environments and goes through only when all of them are allowed. Empty when every id
 * is writable. `canWriteType` is the role's grant for an environment type.
 */
export function findRefusedEnvironments<E extends WriteCheckEnvironment>(
  projectEnvironments: ReadonlyArray<E>,
  submittedIds: ReadonlyArray<string>,
  userId: string,
  canWriteType: (type: E["type"]) => boolean
): RefusedEnvironment<E>[] {
  const byId = new Map(projectEnvironments.map((e) => [e.id, e]));
  return [...new Set(submittedIds)].flatMap((id): RefusedEnvironment<E>[] => {
    const environment = byId.get(id);
    if (!environment) return [{ id, reason: "notFound" }];
    if (!canWriteType(environment.type)) return [{ id, reason: "noPermission", environment }];
    if (findUnauthorizedEnvironmentId([environment], [id], userId)) {
      return [{ id, reason: "notOwner", environment }];
    }
    return [];
  });
}

/**
 * Why copying values from one environment to another is refused, as a sentence, or null when
 * the user may read the source and write the target. Both ids are user-supplied:
 * `projectEnvironments` are this project's environments that aren't archived.
 */
export function findCopyRefusal<E extends WriteCheckEnvironment & { branchName?: string | null }>(
  projectEnvironments: ReadonlyArray<E>,
  {
    sourceEnvironmentId,
    targetEnvironmentId,
    userId,
    canReadType,
    canWriteType,
    title,
  }: {
    sourceEnvironmentId: string;
    targetEnvironmentId: string;
    userId: string;
    canReadType: (type: E["type"]) => boolean;
    canWriteType: (type: E["type"]) => boolean;
    /** The environment's name in the sentence. */
    title: (environment: E) => string;
  }
): string | null {
  const source = projectEnvironments.find((e) => e.id === sourceEnvironmentId);
  if (!source) {
    return "Nothing was copied. The environment to copy from wasn't found in this project.";
  }
  if (sourceEnvironmentId === targetEnvironmentId) {
    return "Nothing was copied. Pick two different environments.";
  }
  // A Development environment is read only by its owner, as it is written.
  if (!canReadType(source.type) || findUnauthorizedEnvironmentId([source], [source.id], userId)) {
    return `Nothing was copied. You don't have permission to view environment variables in ${title(source)}.`;
  }
  const [refused] = findRefusedEnvironments(
    projectEnvironments,
    [targetEnvironmentId],
    userId,
    canWriteType
  );
  switch (refused?.reason) {
    case undefined:
      return null;
    case "notFound":
      return "Nothing was copied. The environment to copy to wasn't found in this project. It may be an archived branch.";
    case "noPermission":
    case "notOwner":
      return `Nothing was copied. You don't have permission to change environment variables in ${title(refused.environment)}.`;
  }
}
