import { describe, expect, it } from "vitest";
import {
  adoptRepositoryAfterCreateRace,
  createEcrClient,
  getDeploymentImageRef,
  getEcrAuthToken,
  isRepositoryAlreadyExistsError,
  parseEcrRegistryDomain,
  parseRegistryTags,
} from "../app/v3/getDeploymentImageRef.server";
import {
  DeleteRepositoryCommand,
  GetLifecyclePolicyCommand,
  RepositoryAlreadyExistsException,
  RepositoryNotFoundException,
} from "@aws-sdk/client-ecr";

describe("getDeploymentImageRef", () => {
  const testHost =
    process.env.DEPLOY_REGISTRY_HOST || "123456789012.dkr.ecr.us-east-1.amazonaws.com";
  const testNamespace = process.env.DEPLOY_REGISTRY_NAMESPACE || "test-namespace";
  const testProjectRef = "proj_test_" + Math.random().toString(36).substring(7);
  const testProjectRef2 = testProjectRef + "_2";
  const testProjectRef3 = testProjectRef + "_3";

  const registryTags = process.env.DEPLOY_REGISTRY_ECR_TAGS || "test=test,test2=test2";
  const roleArn = process.env.DEPLOY_REGISTRY_ECR_ASSUME_ROLE_ARN;
  const externalId = process.env.DEPLOY_REGISTRY_ECR_ASSUME_ROLE_EXTERNAL_ID;
  const assumeRole = {
    roleArn,
    externalId,
  };

  // Clean up test repository after tests
  afterAll(async () => {
    if (process.env.KEEP_TEST_REPO === "1" || process.env.RUN_ECR_TESTS !== "1") {
      return;
    }

    try {
      const { region, accountId } = parseEcrRegistryDomain(testHost);
      const ecr = await createEcrClient({ region, assumeRole });

      await Promise.all([
        ecr.send(
          new DeleteRepositoryCommand({
            repositoryName: `${testNamespace}/${testProjectRef}`,
            registryId: accountId,
            force: true,
          })
        ),
        ecr.send(
          new DeleteRepositoryCommand({
            repositoryName: `${testNamespace}/${testProjectRef2}`,
            registryId: accountId,
            force: true,
          })
        ),
        ecr.send(
          new DeleteRepositoryCommand({
            repositoryName: `${testNamespace}/${testProjectRef3}`,
            registryId: accountId,
            force: true,
          })
        ),
      ]);
    } catch (error) {
      console.warn("Failed to delete test repository:", error);
    }
  });

  it("should return the correct image ref for non-ECR registry", async () => {
    const imageRef = await getDeploymentImageRef({
      registry: {
        host: "registry.example.com",
        namespace: testNamespace,
        username: "test-user",
        password: "test-pass",
        ecrTags: registryTags,
        ecrAssumeRoleArn: roleArn,
        ecrAssumeRoleExternalId: externalId,
      },
      projectRef: testProjectRef,
      nextVersion: "20250630.1",
      environmentType: "DEVELOPMENT",
      deploymentShortCode: "test1234",
    });

    // Check the image ref structure and that it contains expected parts
    expect(imageRef.imageRef).toBe(
      `registry.example.com/${testNamespace}/${testProjectRef}:20250630.1.development.test1234`
    );
    expect(imageRef.isEcr).toBe(false);
  });

  it.skipIf(process.env.RUN_ECR_TESTS !== "1")(
    "should create ECR repository and return correct image ref",
    async () => {
      const imageRef1 = await getDeploymentImageRef({
        registry: {
          host: testHost,
          namespace: testNamespace,
          username: "test-user",
          password: "test-pass",
          ecrTags: registryTags,
          ecrAssumeRoleArn: roleArn,
          ecrAssumeRoleExternalId: externalId,
        },
        projectRef: testProjectRef2,
        nextVersion: "20250630.1",
        environmentType: "DEVELOPMENT",
        deploymentShortCode: "test1234",
      });

      expect(imageRef1.imageRef).toBe(
        `${testHost}/${testNamespace}/${testProjectRef2}:20250630.1.development.test1234`
      );
      expect(imageRef1.isEcr).toBe(true);
      expect(imageRef1.repoCreated).toBe(true);

      const imageRef2 = await getDeploymentImageRef({
        registry: {
          host: testHost,
          namespace: testNamespace,
          username: "test-user",
          password: "test-pass",
          ecrTags: registryTags,
          ecrAssumeRoleArn: roleArn,
          ecrAssumeRoleExternalId: externalId,
        },
        projectRef: testProjectRef2,
        nextVersion: "20250630.2",
        environmentType: "DEVELOPMENT",
        deploymentShortCode: "test1234",
      });

      expect(imageRef2.imageRef).toBe(
        `${testHost}/${testNamespace}/${testProjectRef2}:20250630.2.development.test1234`
      );
      expect(imageRef2.isEcr).toBe(true);
      expect(imageRef2.repoCreated).toBe(false);
    }
  );

  it.skipIf(process.env.RUN_ECR_TESTS !== "1")("should reuse existing ECR repository", async () => {
    // This should use the repository created in the previous test
    const imageRef = await getDeploymentImageRef({
      registry: {
        host: testHost,
        namespace: testNamespace,
        username: "test-user",
        password: "test-pass",
        ecrTags: registryTags,
        ecrAssumeRoleArn: roleArn,
        ecrAssumeRoleExternalId: externalId,
      },
      projectRef: testProjectRef,
      nextVersion: "20250630.2",
      environmentType: "PRODUCTION",
      deploymentShortCode: "test1234",
    });

    expect(imageRef.imageRef).toBe(
      `${testHost}/${testNamespace}/${testProjectRef}:20250630.2.production.test1234`
    );
    expect(imageRef.isEcr).toBe(true);
  });

  it.skipIf(process.env.RUN_ECR_TESTS !== "1")(
    "lets parallel first deploys of a new project share the repository one of them creates",
    async () => {
      const results = await Promise.all(
        ["race1", "race2", "race3"].map((deploymentShortCode, index) =>
          getDeploymentImageRef({
            registry: {
              host: testHost,
              namespace: testNamespace,
              username: "test-user",
              password: "test-pass",
              ecrTags: registryTags,
              ecrAssumeRoleArn: roleArn,
              ecrAssumeRoleExternalId: externalId,
            },
            projectRef: testProjectRef3,
            nextVersion: `20250630.${index + 1}`,
            environmentType: "PRODUCTION",
            deploymentShortCode,
          })
        )
      );

      expect(results.every((result) => result.isEcr)).toBe(true);
      expect(results.filter((result) => result.repoCreated)).toHaveLength(1);

      const { region, accountId } = parseEcrRegistryDomain(testHost);
      const ecr = await createEcrClient({ region, assumeRole });
      const lifecycle = await ecr.send(
        new GetLifecyclePolicyCommand({
          repositoryName: `${testNamespace}/${testProjectRef3}`,
          registryId: accountId,
        })
      );
      expect(lifecycle.lifecyclePolicyText).toContain("untagged");
    },
    60_000
  );

  it("should generate unique image tags for different deployments with same environment type", async () => {
    // Simulates the scenario where multiple deployments happen to the same environment type
    const sameEnvironmentType = "PREVIEW";
    const sameVersion = "20250630.1";

    const firstImageRef = await getDeploymentImageRef({
      registry: {
        host: "registry.example.com",
        namespace: testNamespace,
        username: "test-user",
        password: "test-pass",
        ecrTags: registryTags,
        ecrAssumeRoleArn: roleArn,
        ecrAssumeRoleExternalId: externalId,
      },
      projectRef: testProjectRef,
      nextVersion: sameVersion,
      environmentType: sameEnvironmentType,
      deploymentShortCode: "test1234",
    });

    const secondImageRef = await getDeploymentImageRef({
      registry: {
        host: "registry.example.com",
        namespace: testNamespace,
        username: "test-user",
        password: "test-pass",
        ecrTags: registryTags,
        ecrAssumeRoleArn: roleArn,
        ecrAssumeRoleExternalId: externalId,
      },
      projectRef: testProjectRef,
      nextVersion: sameVersion,
      environmentType: sameEnvironmentType,
      deploymentShortCode: "test4321",
    });

    // Even with the same environment type and version, the image refs should be different due to deployment short codes
    expect(firstImageRef.imageRef).toBe(
      `registry.example.com/${testNamespace}/${testProjectRef}:${sameVersion}.preview.test1234`
    );
    expect(secondImageRef.imageRef).toBe(
      `registry.example.com/${testNamespace}/${testProjectRef}:${sameVersion}.preview.test4321`
    );
    expect(firstImageRef.imageRef).not.toBe(secondImageRef.imageRef);
  });
});

describe.skipIf(process.env.RUN_ECR_TESTS !== "1")("getEcrAuthToken", () => {
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
    expect(auth.password).toMatch(/^[A-Za-z0-9+/=]+$/);
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

describe("isRepositoryAlreadyExistsError", () => {
  // Catches: a lost create race not being recognised when the error comes from another copy of
  // the ECR client, where instanceof fails, so the deploy fails instead of using the repository.
  it("recognises the error ECR returns when the repository was just created by someone else", () => {
    expect(
      isRepositoryAlreadyExistsError(
        new RepositoryAlreadyExistsException({ message: "already exists", $metadata: {} })
      )
    ).toBe(true);
    const fromAnotherClientCopy = Object.assign(new Error("already exists"), {
      name: "RepositoryAlreadyExistsException",
    });
    expect(isRepositoryAlreadyExistsError(fromAnotherClientCopy)).toBe(true);
  });

  // Catches: a missing repository or a network error being taken for a lost race, so the deploy
  // carries on with a repository that doesn't exist.
  it("recognises the plain Error that @aws-sdk/client-ecr 3.9xx deserialises the code into", () => {
    // Observed on test cloud with client-ecr 3.931.0: name is "Error" and the service's error
    // code is only on `__type`. The previous matcher missed it and the deploy failed.
    const fromCurrentSdk = Object.assign(
      new Error("The repository with name 'x' already exists in the registry with id '1'"),
      { __type: "RepositoryAlreadyExistsException", $fault: "client", $metadata: {} }
    );
    expect(isRepositoryAlreadyExistsError(fromCurrentSdk)).toBe(true);
  });

  it("does not treat other ECR errors or plain errors as a race", () => {
    expect(
      isRepositoryAlreadyExistsError(
        new RepositoryNotFoundException({ message: "not found", $metadata: {} })
      )
    ).toBe(false);
    expect(isRepositoryAlreadyExistsError(new Error("network down"))).toBe(false);
    expect(isRepositoryAlreadyExistsError(undefined)).toBe(false);
  });
});

describe("adoptRepositoryAfterCreateRace", () => {
  const context = {
    repositoryName: "ns/proj_race",
    region: "us-east-1",
    accountId: "123456789012",
  };
  const alreadyExists = new RepositoryAlreadyExistsException({
    message: "already exists",
    $metadata: {},
  });

  // Catches: a deploy that lost the race to create its project's repository failing with an image
  // reference error instead of using the repository the other deploy made.
  it("carries on with the repository that already exists", async () => {
    const existing = {
      repositoryName: context.repositoryName,
      imageTagMutability: "IMMUTABLE" as const,
    };
    const repo = await adoptRepositoryAfterCreateRace(
      alreadyExists,
      async () => existing,
      context,
      {
        delayMs: 0,
      }
    );
    expect(repo).toEqual(existing);
  });

  // Catches: the deploy still failing when the read right after the race misses the new repository.
  it("carries on by name when the repository can't be read back", async () => {
    let reads = 0;
    const repo = await adoptRepositoryAfterCreateRace(
      alreadyExists,
      async () => {
        reads++;
        throw new Error("throttled");
      },
      context,
      { delayMs: 0 }
    );
    expect(repo).toEqual({ repositoryName: context.repositoryName, registryId: context.accountId });
    expect(reads).toBe(3);
  });

  // Catches: an unrelated create failure (throttling, quota) being treated as a race and swallowed.
  it("leaves any other create error to the caller", async () => {
    expect(
      await adoptRepositoryAfterCreateRace(
        new Error("throttled"),
        async () => ({ repositoryName: context.repositoryName }),
        context,
        { delayMs: 0 }
      )
    ).toBe(undefined);
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

describe("parseRegistryTags", () => {
  it("should handle empty or null input", () => {
    expect(parseRegistryTags("")).toEqual([]);
    expect(parseRegistryTags(",,,")).toEqual([]);
  });

  it("should parse key-only tags", () => {
    expect(parseRegistryTags("key1,key2")).toEqual([
      { Key: "key1", Value: "" },
      { Key: "key2", Value: "" },
    ]);
  });

  it("should parse key-value tags", () => {
    expect(parseRegistryTags("key1=value1,key2=value2")).toEqual([
      { Key: "key1", Value: "value1" },
      { Key: "key2", Value: "value2" },
    ]);
  });

  it("should handle mixed key-only and key-value tags", () => {
    expect(parseRegistryTags("key1,key2=value2,key3")).toEqual([
      { Key: "key1", Value: "" },
      { Key: "key2", Value: "value2" },
      { Key: "key3", Value: "" },
    ]);
  });

  it("should handle whitespace", () => {
    expect(parseRegistryTags(" key1 , key2 = value2 ")).toEqual([
      { Key: "key1", Value: "" },
      { Key: "key2", Value: "value2" },
    ]);
  });

  it("should skip invalid tags", () => {
    expect(parseRegistryTags("=value,key1,=,key2=value2")).toEqual([
      { Key: "key1", Value: "" },
      { Key: "key2", Value: "value2" },
    ]);
  });
});
