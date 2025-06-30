import { describe, expect, it } from "vitest";
import {
  getDeploymentImageRef,
  getEcrAuthToken,
  getEcrRegion,
} from "../app/v3/getDeploymentImageRef.server";
import { ECRClient, DeleteRepositoryCommand } from "@aws-sdk/client-ecr";

describe.skipIf(process.env.RUN_REGISTRY_TESTS !== "1")("getDeploymentImageRef", () => {
  const testHost = "123456789012.dkr.ecr.us-east-1.amazonaws.com";
  const testNamespace = "test-namespace";
  const testProjectRef = "test-project-" + Math.random().toString(36).substring(7);

  const registryId = process.env.DEPLOY_REGISTRY_ID;
  const registryTags = "test=test,test2=test2";

  // Clean up test repository after tests
  afterAll(async () => {
    if (!registryId) {
      return;
    }

    if (process.env.KEEP_TEST_REPO === "1") {
      return;
    }

    try {
      const region = getEcrRegion(testHost);
      const ecr = new ECRClient({ region });
      await ecr.send(
        new DeleteRepositoryCommand({
          repositoryName: `${testNamespace}/${testProjectRef}`,
          registryId,
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
      registryId,
      registryTags,
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
      registryId,
      registryTags,
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
      registryId,
      registryTags,
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
        registryId,
        registryTags,
      })
    ).rejects.toThrow("Invalid ECR registry host: invalid.ecr.amazonaws.com");
  });
});

describe.skipIf(process.env.RUN_REGISTRY_AUTH_TESTS !== "1")("getEcrAuthToken", () => {
  const registryId = process.env.DEPLOY_REGISTRY_ID;
  const testHost = "123456789012.dkr.ecr.us-east-1.amazonaws.com";

  it("should return valid ECR credentials", async () => {
    const auth = await getEcrAuthToken({
      registryHost: testHost,
      registryId,
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
        registryId,
      })
    ).rejects.toThrow();
  });
});
