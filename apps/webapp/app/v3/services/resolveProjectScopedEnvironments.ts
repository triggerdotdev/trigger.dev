// Resolve a caller-supplied list of environment ids against the environments
// that belong to the authorized project. Any id not in the project is reported
// as `foreign` so the caller can reject the request rather than silently drop
// it. Returns a discriminated result instead of throwing so it stays
// dependency-free and unit-testable.

export type ProjectScopedEnvironmentsResult<E> =
  | { kind: "foreign"; foreignEnvironmentId: string }
  | { kind: "ok"; environments: E[] };

export function resolveProjectScopedEnvironments<E extends { id: string }>(
  environmentIds: string[],
  projectEnvironments: ReadonlyArray<E>
): ProjectScopedEnvironmentsResult<E> {
  const byId = new Map(projectEnvironments.map((e) => [e.id, e]));

  const foreignEnvironmentId = environmentIds.find((id) => !byId.has(id));
  // Explicit undefined check: an empty-string id is a foreign id that must be
  // rejected, but it is falsy, so a truthiness test would silently drop it
  // instead.
  if (foreignEnvironmentId !== undefined) {
    return { kind: "foreign", foreignEnvironmentId };
  }

  const environments = environmentIds.map((id) => byId.get(id)).filter((e): e is E => Boolean(e));
  return { kind: "ok", environments };
}
