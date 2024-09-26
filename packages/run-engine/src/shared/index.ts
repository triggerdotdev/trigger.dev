import { Attributes } from "@opentelemetry/api";
import { Prisma } from "@trigger.dev/database";

type EnvironmentWithExtras = Prisma.RuntimeEnvironmentGetPayload<{
  include: { project: true; organization: true; orgMember: true };
}>;

export type AuthenticatedEnvironment = {
  id: EnvironmentWithExtras["id"];
  type: EnvironmentWithExtras["type"];
  maximumConcurrencyLimit: EnvironmentWithExtras["maximumConcurrencyLimit"];
  project: {
    id: EnvironmentWithExtras["project"]["id"];
  };
  organization: {
    id: EnvironmentWithExtras["organization"]["id"];
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

export function attributesFromAuthenticatedEnv(env: AuthenticatedEnvironment): Attributes {
  return {
    [SemanticEnvResources.ENV_ID]: env.id,
    [SemanticEnvResources.ENV_TYPE]: env.type,
    [SemanticEnvResources.ORG_ID]: env.organization.id,
    [SemanticEnvResources.PROJECT_ID]: env.project.id,
  };
}
