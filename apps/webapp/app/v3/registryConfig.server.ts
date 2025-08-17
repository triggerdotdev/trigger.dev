import { env } from "~/env.server";

export type RegistryConfig = {
  host: string;
  username?: string;
  password?: string;
  namespace: string;
  ecrTags?: string;
  ecrAssumeRoleArn?: string;
  ecrAssumeRoleExternalId?: string;
};

export function getRegistryConfig(isV4Deployment: boolean): RegistryConfig {
  if (isV4Deployment) {
    return {
      host: env.V4_DEPLOY_REGISTRY_HOST,
      username: env.V4_DEPLOY_REGISTRY_USERNAME,
      password: env.V4_DEPLOY_REGISTRY_PASSWORD,
      namespace: env.V4_DEPLOY_REGISTRY_NAMESPACE,
      ecrTags: env.V4_DEPLOY_REGISTRY_ECR_TAGS,
      ecrAssumeRoleArn: env.V4_DEPLOY_REGISTRY_ECR_ASSUME_ROLE_ARN,
      ecrAssumeRoleExternalId: env.V4_DEPLOY_REGISTRY_ECR_ASSUME_ROLE_EXTERNAL_ID,
    };
  }

  return {
    host: env.DEPLOY_REGISTRY_HOST,
    username: env.DEPLOY_REGISTRY_USERNAME,
    password: env.DEPLOY_REGISTRY_PASSWORD,
    namespace: env.DEPLOY_REGISTRY_NAMESPACE,
    ecrTags: env.DEPLOY_REGISTRY_ECR_TAGS,
    ecrAssumeRoleArn: env.DEPLOY_REGISTRY_ECR_ASSUME_ROLE_ARN,
    ecrAssumeRoleExternalId: env.DEPLOY_REGISTRY_ECR_ASSUME_ROLE_EXTERNAL_ID,
  };
}
