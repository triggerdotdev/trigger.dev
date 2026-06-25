import { RepositoryNotFoundException } from "@aws-sdk/client-ecr";
import { describe, expect, it } from "vitest";
import {
  ecrImageExists,
  interpretBatchGetImageResponse,
  parseEcrImageReference,
} from "~/v3/services/verifyDeploymentImage.server";
import { type RegistryConfig } from "~/v3/registryConfig.server";

const ECR_HOST = "123456789012.dkr.ecr.us-east-1.amazonaws.com";
const ecrConfig: RegistryConfig = { host: ECR_HOST, namespace: "deployments-test" };

describe("parseEcrImageReference", () => {
  it("splits repository and tag for a ref under the configured host", () => {
    const ref = `${ECR_HOST}/deployments-test/proj_abc:20240101.1.prod.a1b2c3d4`;
    expect(parseEcrImageReference(ref, ECR_HOST)).toEqual({
      repositoryName: "deployments-test/proj_abc",
      tag: "20240101.1.prod.a1b2c3d4",
    });
  });

  it("drops a trailing @sha256 digest", () => {
    const ref = `${ECR_HOST}/deployments-test/proj_abc:v1.prod.a1b2c3d4@sha256:${"a".repeat(64)}`;
    expect(parseEcrImageReference(ref, ECR_HOST)).toEqual({
      repositoryName: "deployments-test/proj_abc",
      tag: "v1.prod.a1b2c3d4",
    });
  });

  it("returns null when the ref is not under the configured host (trust boundary)", () => {
    const ref = "evil.example.com/whatever/proj_abc:v1";
    expect(parseEcrImageReference(ref, ECR_HOST)).toBeNull();
  });

  it("returns null when there is no tag", () => {
    expect(parseEcrImageReference(`${ECR_HOST}/deployments-test/proj_abc`, ECR_HOST)).toBeNull();
  });

  it("returns null when the tag segment contains a slash", () => {
    // a stray colon earlier in the path must not be treated as the tag separator
    expect(parseEcrImageReference(`${ECR_HOST}/ns:weird/proj_abc`, ECR_HOST)).toBeNull();
  });
});

describe("interpretBatchGetImageResponse", () => {
  it("returns found when an image is present", () => {
    expect(interpretBatchGetImageResponse({ images: [{}] } as any)).toBe("found");
  });

  it("returns missing on an ImageNotFound failure", () => {
    expect(
      interpretBatchGetImageResponse({ failures: [{ failureCode: "ImageNotFound" }] } as any)
    ).toBe("missing");
  });

  it("returns unknown when there is neither an image nor a not-found failure", () => {
    expect(interpretBatchGetImageResponse({ failures: [{ failureCode: "Other" }] } as any)).toBe(
      "unknown"
    );
    expect(interpretBatchGetImageResponse({} as any)).toBe("unknown");
  });
});

describe("ecrImageExists", () => {
  it("returns unknown for a non-ECR registry without calling the registry", async () => {
    let called = false;
    const result = await ecrImageExists(
      {
        imageReference: "registry.digitalocean.com/trigger-deployments/proj_abc:v1",
        registryConfig: { host: "registry.digitalocean.com", namespace: "trigger-deployments" },
      },
      async () => {
        called = true;
        return {} as any;
      }
    );
    expect(result).toBe("unknown");
    expect(called).toBe(false);
  });

  it("returns unknown for an unparseable ECR ref without calling the registry", async () => {
    let called = false;
    const result = await ecrImageExists(
      {
        imageReference: `${ECR_HOST}/deployments-test/proj_abc`,
        registryConfig: ecrConfig,
      },
      async () => {
        called = true;
        return {} as any;
      }
    );
    expect(result).toBe("unknown");
    expect(called).toBe(false);
  });

  it("returns found when the image exists", async () => {
    const result = await ecrImageExists(
      {
        imageReference: `${ECR_HOST}/deployments-test/proj_abc:v1.prod.a1b2c3d4`,
        registryConfig: ecrConfig,
      },
      async () => ({ images: [{}] }) as any
    );
    expect(result).toBe("found");
  });

  it("returns missing when the registry reports ImageNotFound", async () => {
    const result = await ecrImageExists(
      {
        imageReference: `${ECR_HOST}/deployments-test/proj_abc:v1.prod.a1b2c3d4`,
        registryConfig: ecrConfig,
      },
      async () => ({ failures: [{ failureCode: "ImageNotFound" }] }) as any
    );
    expect(result).toBe("missing");
  });

  it("returns unknown when the registry call throws an ambiguous error", async () => {
    const result = await ecrImageExists(
      {
        imageReference: `${ECR_HOST}/deployments-test/proj_abc:v1.prod.a1b2c3d4`,
        registryConfig: ecrConfig,
      },
      async () => {
        throw new Error("AccessDenied");
      }
    );
    expect(result).toBe("unknown");
  });

  it("returns missing when the repository does not exist", async () => {
    const result = await ecrImageExists(
      {
        imageReference: `${ECR_HOST}/deployments-test/proj_abc:v1.prod.a1b2c3d4`,
        registryConfig: ecrConfig,
      },
      async () => {
        throw new RepositoryNotFoundException({ message: "not found", $metadata: {} });
      }
    );
    expect(result).toBe("missing");
  });

  it("queries by digest when a valid digest is supplied", async () => {
    const digest = `sha256:${"b".repeat(64)}`;
    let seen: any;
    await ecrImageExists(
      {
        imageReference: `${ECR_HOST}/deployments-test/proj_abc:v1.prod.a1b2c3d4`,
        imageDigest: digest,
        registryConfig: ecrConfig,
      },
      async (input) => {
        seen = input;
        return { images: [{}] } as any;
      }
    );
    expect(seen.imageIds).toEqual([{ imageDigest: digest }]);
  });

  it("falls back to the tag when the supplied digest is malformed", async () => {
    let seen: any;
    await ecrImageExists(
      {
        imageReference: `${ECR_HOST}/deployments-test/proj_abc:v1.prod.a1b2c3d4`,
        imageDigest: "not-a-digest",
        registryConfig: ecrConfig,
      },
      async (input) => {
        seen = input;
        return { images: [{}] } as any;
      }
    );
    expect(seen.imageIds).toEqual([{ imageTag: "v1.prod.a1b2c3d4" }]);
  });
});
