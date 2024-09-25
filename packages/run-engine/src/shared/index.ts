import { Attributes } from "@opentelemetry/api";
import { Prisma } from "@trigger.dev/database";

export type AuthenticatedEnvironment = Prisma.RuntimeEnvironmentGetPayload<{
  include: { project: true; organization: true; orgMember: true };
}>;

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
    [SemanticEnvResources.ENV_SLUG]: env.slug,
    [SemanticEnvResources.ORG_ID]: env.organizationId,
    [SemanticEnvResources.ORG_SLUG]: env.organization.slug,
    [SemanticEnvResources.ORG_TITLE]: env.organization.title,
    [SemanticEnvResources.PROJECT_ID]: env.projectId,
    [SemanticEnvResources.PROJECT_NAME]: env.project.name,
    [SemanticEnvResources.USER_ID]: env.orgMember?.userId,
  };
}
