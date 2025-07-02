import { describe, expect, it } from "vitest";
import {
  createEcrClient,
  getDeploymentImageRef,
  getEcrAuthToken,
  parseEcrRegistryDomain,
} from "../app/v3/getDeploymentImageRef.server";
import { DeleteRepositoryCommand } from "@aws-sdk/client-ecr";

describe.skipIf(process.env.RUN_REGISTRY_TESTS !== "1")("getDeploymentImageRef", () => {
  const testHost =
    process.env.DEPLOY_REGISTRY_HOST || "123456789012.dkr.ecr.us-east-1.amazonaws.com";
  const testNamespace = process.env.DEPLOY_REGISTRY_NAMESPACE || "test-namespace";
  const testProjectRef = "proj_test_" + Math.random().toString(36).substring(7);

  const registryTags = process.env.DEPLOY_REGISTRY_ECR_TAGS || "test=test,test2=test2";
  const roleArn = process.env.DEPLOY_REGISTRY_ECR_ASSUME_ROLE_ARN;
  const externalId = process.env.DEPLOY_REGISTRY_ECR_ASSUME_ROLE_EXTERNAL_ID;
  const assumeRole = {
    roleArn,
    externalId,
  };

  // Clean up test repository after tests
  afterAll(async () => {
    if (process.env.KEEP_TEST_REPO === "1") {
      return;
    }

    try {
      const { region, accountId } = parseEcrRegistryDomain(testHost);
      const ecr = await createEcrClient({ region, assumeRole });
      await ecr.send(
        new DeleteRepositoryCommand({
          repositoryName: `${testNamespace}/${testProjectRef}`,
          registryId: accountId,
          force: true,
        })
      );
    } catch (error) {
      console.warn("Failed to delete test repository:", error);
    }
  });

  it("should return the correct image ref for non-ECR registry", async () => {
    const imageRef = await getDeploymentImageRef({
      host: "registry.digitalocean.com",
      namespace: testNamespace,
      projectRef: testProjectRef,
      nextVersion: "20250630.1",
      environmentSlug: "test",
      registryTags,
      assumeRole,
    });

    expect(imageRef.imageRef).toBe(
      `registry.digitalocean.com/${testNamespace}/${testProjectRef}:20250630.1.test`
    );
    expect(imageRef.isEcr).toBe(false);
  });

  it("should create ECR repository and return correct image ref", async () => {
    const imageRef = await getDeploymentImageRef({
      host: testHost,
      namespace: testNamespace,
      projectRef: testProjectRef,
      nextVersion: "20250630.1",
      environmentSlug: "test",
      registryTags,
      assumeRole,
    });

    expect(imageRef.imageRef).toBe(
      `${testHost}/${testNamespace}/${testProjectRef}:20250630.1.test`
    );
    expect(imageRef.isEcr).toBe(true);
  });

  it("should reuse existing ECR repository", async () => {
    // This should use the repository created in the previous test
    const imageRef = await getDeploymentImageRef({
      host: testHost,
      namespace: testNamespace,
      projectRef: testProjectRef,
      nextVersion: "20250630.2",
      environmentSlug: "prod",
      registryTags,
      assumeRole,
    });

    expect(imageRef.imageRef).toBe(
      `${testHost}/${testNamespace}/${testProjectRef}:20250630.2.prod`
    );
    expect(imageRef.isEcr).toBe(true);
  });

  it("should throw error for invalid ECR host", async () => {
    await expect(
      getDeploymentImageRef({
        host: "invalid.ecr.amazonaws.com",
        namespace: testNamespace,
        projectRef: testProjectRef,
        nextVersion: "20250630.1",
        environmentSlug: "test",
        registryTags,
        assumeRole,
      })
    ).rejects.toThrow("Invalid ECR registry host: invalid.ecr.amazonaws.com");
  });
});

describe.skipIf(process.env.RUN_REGISTRY_AUTH_TESTS !== "1")("getEcrAuthToken", () => {
  const testHost =
    process.env.DEPLOY_REGISTRY_HOST || "123456789012.dkr.ecr.us-east-1.amazonaws.com";

  const roleArn = process.env.DEPLOY_REGISTRY_ECR_ASSUME_ROLE_ARN;
  const externalId = process.env.DEPLOY_REGISTRY_ECR_ASSUME_ROLE_EXTERNAL_ID;
  const assumeRole = {
    roleArn,
    externalId,
  };

  it("should return valid ECR credentials", async () => {
    const auth = await getEcrAuthToken({
      registryHost: testHost,
      assumeRole,
    });

    // Check the structure and basic validation of the returned credentials
    expect(auth).toHaveProperty("username");
    expect(auth).toHaveProperty("password");
    expect(auth.username).toBe("AWS");
    expect(typeof auth.password).toBe("string");
    expect(auth.password.length).toBeGreaterThan(0);

    // Verify the token format (should be a base64-encoded string)
    const base64Regex = /^[A-Za-z0-9+/=]+$/;
    expect(base64Regex.test(auth.password)).toBe(true);
  });

  it("should throw error for invalid region", async () => {
    await expect(
      getEcrAuthToken({
        registryHost: "invalid.ecr.amazonaws.com",
        assumeRole,
      })
    ).rejects.toThrow();
  });
});

describe("parseEcrRegistry", () => {
  it("should correctly parse a valid ECR registry host", () => {
    const result = parseEcrRegistryDomain("123456789012.dkr.ecr.us-east-1.amazonaws.com");
    expect(result).toEqual({
      accountId: "123456789012",
      region: "us-east-1",
    });
  });

  it("should handle invalid ECR registry hosts", () => {
    const invalidHosts = [
      "invalid.ecr.amazonaws.com",
      "registry.hub.docker.com",
      "123456789012.dkr.ecr.us-east-1.not-amazon.com",
      "123456789012.wrong.ecr.us-east-1.amazonaws.com",
    ];

    for (const host of invalidHosts) {
      expect(() => parseEcrRegistryDomain(host)).toThrow("Invalid ECR registry host");
    }
  });
});
