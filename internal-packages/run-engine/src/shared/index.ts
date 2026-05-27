import type { Attributes } from "@internal/tracing";

// Slim, structural shape carried across the auth boundary. Defined in
// @trigger.dev/core so it's importable from internal packages and the
// RBAC plugin contract without depending on @trigger.dev/database.
export type { AuthenticatedEnvironment } from "@trigger.dev/core/v3/auth/environment";
import type { AuthenticatedEnvironment } from "@trigger.dev/core/v3/auth/environment";

// Run-engine internal type — what enqueue/dequeue/concurrency code
// actually needs from an env. Independent of `AuthenticatedEnvironment`
// (the auth-boundary slim type) because internals receive Prisma
// payloads where `concurrencyLimitBurstFactor` is `Decimal`. Accept
// both number and a Decimal-like duck type so callers don't need to
// coerce at every site.
export type MinimalAuthenticatedEnvironment = {
  id: string;
  type: AuthenticatedEnvironment["type"];
  maximumConcurrencyLimit: number;
  concurrencyLimitBurstFactor: number | { toNumber(): number };
  project: { id: string };
  organization: { id: string };
};

const SemanticEnvResources = {
  ENV_ID: "$trigger.env.id",
  ENV_TYPE: "$trigger.env.type",
  ENV_SLUG: "$trigger.env.slug",
  ORG_ID: "$trigger.org.id",
  ORG_SLUG: "$trigger.org.slug",
  ORG_TITLE: "$trigger.org.title",
  PROJECT_ID: "$trigger.project.id",
  PROJECT_NAME: "$trigger.project.name",
  USER_ID: "$trigger.user.id",
};

export function attributesFromAuthenticatedEnv(env: MinimalAuthenticatedEnvironment): Attributes {
  return {
    [SemanticEnvResources.ENV_ID]: env.id,
    [SemanticEnvResources.ENV_TYPE]: env.type,
    [SemanticEnvResources.ORG_ID]: env.organization.id,
    [SemanticEnvResources.PROJECT_ID]: env.project.id,
  };
}
