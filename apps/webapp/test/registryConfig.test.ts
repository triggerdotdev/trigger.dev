import { describe, expect, it, vi, beforeEach } from "vitest";

describe("getRegistryConfig", () => {
  // Base env with all required fields to make env.server.ts happy
  const baseEnv = {
    NODE_ENV: "test" as const,
    DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    DIRECT_URL: "postgresql://test:test@localhost:5432/test",
    SESSION_SECRET: "test-session-secret",
    MAGIC_LINK_SECRET: "test-magic-link-secret",
    ENCRYPTION_KEY: "test-encryption-keeeeey-32-bytes",
    CLICKHOUSE_URL: "http://localhost:8123",
  };

  beforeEach(() => {
    // Reset modules to ensure fresh imports
    vi.resetModules();
  });

  it("should return v3 config for non-v4 deployments", async () => {
    // Set up v3 env vars
    process.env = {
      ...baseEnv,
      DEPLOY_REGISTRY_HOST: "v3-host.example.com",
      DEPLOY_REGISTRY_USERNAME: "v3-user",
      DEPLOY_REGISTRY_PASSWORD: "v3-password",
      DEPLOY_REGISTRY_NAMESPACE: "v3-namespace",
      DEPLOY_REGISTRY_ECR_TAGS: "env=v3,version=3",
      DEPLOY_REGISTRY_ECR_ASSUME_ROLE_ARN: "arn:aws:iam::123456789012:role/v3-role",
      DEPLOY_REGISTRY_ECR_ASSUME_ROLE_EXTERNAL_ID: "v3-external-id",
    };

    const { getRegistryConfig } = await import("../app/v3/registryConfig.server");
    const config = getRegistryConfig(false);

    expect(config).toEqual({
      host: "v3-host.example.com",
      username: "v3-user",
      password: "v3-password",
      namespace: "v3-namespace",
      ecrTags: "env=v3,version=3",
      ecrAssumeRoleArn: "arn:aws:iam::123456789012:role/v3-role",
      ecrAssumeRoleExternalId: "v3-external-id",
    });
  });

  it("should return v4 config for v4 deployments when V4 vars are set", async () => {
    // Set up v3 + v4 env vars
    process.env = {
      ...baseEnv,
      DEPLOY_REGISTRY_HOST: "v3-host.example.com",
      DEPLOY_REGISTRY_USERNAME: "v3-user",
      DEPLOY_REGISTRY_PASSWORD: "v3-password",
      DEPLOY_REGISTRY_NAMESPACE: "v3-namespace",
      DEPLOY_REGISTRY_ECR_TAGS: "env=v3,version=3",
      DEPLOY_REGISTRY_ECR_ASSUME_ROLE_ARN: "arn:aws:iam::123456789012:role/v3-role",
      DEPLOY_REGISTRY_ECR_ASSUME_ROLE_EXTERNAL_ID: "v3-external-id",

      V4_DEPLOY_REGISTRY_HOST: "v4-host.example.com",
      V4_DEPLOY_REGISTRY_USERNAME: "v4-user",
      V4_DEPLOY_REGISTRY_PASSWORD: "v4-password",
      V4_DEPLOY_REGISTRY_NAMESPACE: "v4-namespace",
      V4_DEPLOY_REGISTRY_ECR_TAGS: "env=v4,version=4",
      V4_DEPLOY_REGISTRY_ECR_ASSUME_ROLE_ARN: "arn:aws:iam::456789012345:role/v4-role",
      V4_DEPLOY_REGISTRY_ECR_ASSUME_ROLE_EXTERNAL_ID: "v4-external-id",
    };

    const { getRegistryConfig } = await import("../app/v3/registryConfig.server");
    const config = getRegistryConfig(true);

    expect(config).toEqual({
      host: "v4-host.example.com",
      username: "v4-user",
      password: "v4-password",
      namespace: "v4-namespace",
      ecrTags: "env=v4,version=4",
      ecrAssumeRoleArn: "arn:aws:iam::456789012345:role/v4-role",
      ecrAssumeRoleExternalId: "v4-external-id",
    });
  });

  it("should fallback to v3 config when V4 vars are not set", async () => {
    // Set up only v3 env vars (no v4 vars)
    process.env = {
      ...baseEnv,
      DEPLOY_REGISTRY_HOST: "v3-only-host.example.com",
      DEPLOY_REGISTRY_USERNAME: "v3-only-user",
      DEPLOY_REGISTRY_PASSWORD: "v3-only-password",
      DEPLOY_REGISTRY_NAMESPACE: "v3-only-namespace",
      DEPLOY_REGISTRY_ECR_TAGS: "env=v3only",
      DEPLOY_REGISTRY_ECR_ASSUME_ROLE_ARN: "arn:aws:iam::111111111111:role/v3-only-role",
      DEPLOY_REGISTRY_ECR_ASSUME_ROLE_EXTERNAL_ID: "v3-only-external-id",
      // V4 vars not set - should fallback to v3 via transform
    };

    const { getRegistryConfig } = await import("../app/v3/registryConfig.server");
    const config = getRegistryConfig(true);

    expect(config).toEqual({
      host: "v3-only-host.example.com",
      username: "v3-only-user",
      password: "v3-only-password",
      namespace: "v3-only-namespace",
      ecrTags: "env=v3only",
      ecrAssumeRoleArn: "arn:aws:iam::111111111111:role/v3-only-role",
      ecrAssumeRoleExternalId: "v3-only-external-id",
    });
  });

  it("should handle partial v4 config with mixed fallbacks", async () => {
    // Set up v3 vars + only some v4 vars
    process.env = {
      ...baseEnv,
      DEPLOY_REGISTRY_HOST: "v3-mixed-host.example.com",
      DEPLOY_REGISTRY_USERNAME: "v3-mixed-user",
      DEPLOY_REGISTRY_PASSWORD: "v3-mixed-password",
      DEPLOY_REGISTRY_NAMESPACE: "v3-mixed-namespace",
      DEPLOY_REGISTRY_ECR_TAGS: "env=v3mixed",
      DEPLOY_REGISTRY_ECR_ASSUME_ROLE_ARN: "arn:aws:iam::222222222222:role/v3-mixed-role",
      DEPLOY_REGISTRY_ECR_ASSUME_ROLE_EXTERNAL_ID: "v3-mixed-external-id",

      // Only some V4 vars are set - others should fallback to v3
      V4_DEPLOY_REGISTRY_HOST: "v4-partial-host.example.com",
      V4_DEPLOY_REGISTRY_USERNAME: "v4-partial-user",
      // V4_DEPLOY_REGISTRY_PASSWORD not set - should fallback to v3
      // Other V4 vars not set - should fallback to v3
    };

    const { getRegistryConfig } = await import("../app/v3/registryConfig.server");
    const config = getRegistryConfig(true);

    expect(config).toEqual({
      host: "v4-partial-host.example.com", // v4 value
      username: "v4-partial-user", // v4 value
      password: "v3-mixed-password", // v3 fallback
      namespace: "v3-mixed-namespace", // v3 fallback
      ecrTags: "env=v3mixed", // v3 fallback
      ecrAssumeRoleArn: "arn:aws:iam::222222222222:role/v3-mixed-role", // v3 fallback
      ecrAssumeRoleExternalId: "v3-mixed-external-id", // v3 fallback
    });
  });

  it("should handle basic registry config without ECR or V4 vars", async () => {
    // Set up basic registry config without ECR or V4 vars
    process.env = {
      ...baseEnv,
      DEPLOY_REGISTRY_HOST: "registry.example.com",
      DEPLOY_REGISTRY_USERNAME: "basic-user",
      DEPLOY_REGISTRY_PASSWORD: "basic-password",
      DEPLOY_REGISTRY_NAMESPACE: "basic-namespace",
      // No ECR vars and no V4 vars - should all be undefined
    };

    const { getRegistryConfig } = await import("../app/v3/registryConfig.server");

    const v3Config = getRegistryConfig(false);
    const v4Config = getRegistryConfig(true);

    expect(v3Config).toEqual({
      host: "registry.example.com",
      username: "basic-user",
      password: "basic-password",
      namespace: "basic-namespace",
      ecrTags: undefined,
      ecrAssumeRoleArn: undefined,
      ecrAssumeRoleExternalId: undefined,
    });

    // V4 should fallback to v3 values since V4 vars not set
    expect(v4Config).toEqual({
      host: "registry.example.com",
      username: "basic-user",
      password: "basic-password",
      namespace: "basic-namespace",
      ecrTags: undefined,
      ecrAssumeRoleArn: undefined,
      ecrAssumeRoleExternalId: undefined,
    });
  });

  it("should handle undefined/null values gracefully", async () => {
    // Set up minimal required values only
    process.env = {
      ...baseEnv,
      DEPLOY_REGISTRY_HOST: "minimal-host.example.com",
      DEPLOY_REGISTRY_NAMESPACE: "minimal-namespace",
      // Other vars not set - should be undefined
    };

    const { getRegistryConfig } = await import("../app/v3/registryConfig.server");

    const v3Config = getRegistryConfig(false);
    const v4Config = getRegistryConfig(true);

    expect(v3Config).toEqual({
      host: "minimal-host.example.com",
      username: undefined,
      password: undefined,
      namespace: "minimal-namespace",
      ecrTags: undefined,
      ecrAssumeRoleArn: undefined,
      ecrAssumeRoleExternalId: undefined,
    });

    expect(v4Config).toEqual({
      host: "minimal-host.example.com",
      username: undefined,
      password: undefined,
      namespace: "minimal-namespace", // fallback default
      ecrTags: undefined,
      ecrAssumeRoleArn: undefined,
      ecrAssumeRoleExternalId: undefined,
    });
  });
});
