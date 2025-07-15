import type { Attributes } from "@internal/tracing";
import type { Prisma } from "@trigger.dev/database";

export type AuthenticatedEnvironment = Prisma.RuntimeEnvironmentGetPayload<{
  include: { project: true; organization: true; orgMember: true };
}>;

export type MinimalAuthenticatedEnvironment = {
  id: AuthenticatedEnvironment["id"];
  type: AuthenticatedEnvironment["type"];
  maximumConcurrencyLimit: AuthenticatedEnvironment["maximumConcurrencyLimit"];
  concurrencyLimitBurstFactor: AuthenticatedEnvironment["concurrencyLimitBurstFactor"];
  project: {
    id: AuthenticatedEnvironment["project"]["id"];
  };
  organization: {
    id: AuthenticatedEnvironment["organization"]["id"];
  };
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
