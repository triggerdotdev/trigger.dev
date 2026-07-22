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
