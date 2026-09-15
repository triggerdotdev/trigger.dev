// Non-secret subset of an AuthenticatedEnvironment for logging (the full shape
// carries the env's apiKey). Dependency-free so it's unit-tested directly.
export type EnvironmentForLog = {
  id: string;
  slug: string;
  type: string;
  projectId: string;
  organizationId: string;
};

export function safeEnvironmentLogFields(environment: EnvironmentForLog) {
  return {
    id: environment.id,
    slug: environment.slug,
    type: environment.type,
    projectId: environment.projectId,
    organizationId: environment.organizationId,
  };
}
