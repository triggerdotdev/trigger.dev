import { RepositoryNotFoundException } from "@aws-sdk/client-ecr";
import { describe, expect, it } from "vitest";
import {
  ecrImageExists,
  inspectManifest,
  interpretBatchGetImageResponse,
  parseEcrImageReference,
  treeHasUnpullableLayer,
} from "~/v3/services/verifyDeploymentImage.server";
import { type RegistryConfig } from "~/v3/registryConfig.server";

const ECR_HOST = "123456789012.dkr.ecr.us-east-1.amazonaws.com";
const ecrConfig: RegistryConfig = { host: ECR_HOST, namespace: "deployments-test" };

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const ZSTD_DOCKER = "application/vnd.docker.image.rootfs.diff.tar.zstd";

const imageManifest = (layerMediaTypes: string[]) =>
  JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.docker.distribution.manifest.v2+json",
    layers: layerMediaTypes.map((mediaType) => ({ mediaType, digest: DIGEST_A })),
  });

const indexManifest = (childDigests: string[]) =>
  JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: childDigests.map((digest) => ({
      digest,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
    })),
  });

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

describe("inspectManifest", () => {
  it("flags an unpullable zstd layer in an image manifest", () => {
    const result = inspectManifest(
      imageManifest(["application/vnd.docker.image.rootfs.diff.tar.gzip", ZSTD_DOCKER])
    );
    expect(result.hasUnpullableLayer).toBe(true);
    expect(result.childDigests).toEqual([]);
  });

  it("passes OCI zstd and gzip layers (runtime-supported media types)", () => {
    const result = inspectManifest(
      imageManifest([
        "application/vnd.oci.image.layer.v1.tar+gzip",
        "application/vnd.oci.image.layer.v1.tar+zstd",
      ])
    );
    expect(result.hasUnpullableLayer).toBe(false);
  });

  it("returns child digests for an index and does not flag it directly", () => {
    const result = inspectManifest(indexManifest([DIGEST_A, DIGEST_B]));
    expect(result.hasUnpullableLayer).toBe(false);
    expect(result.childDigests).toEqual([DIGEST_A, DIGEST_B]);
  });

  it("fails open (empty) when the manifest is absent or unparseable", () => {
    expect(inspectManifest(undefined)).toEqual({ hasUnpullableLayer: false, childDigests: [] });
    expect(inspectManifest("not json")).toEqual({ hasUnpullableLayer: false, childDigests: [] });
  });
});

describe("treeHasUnpullableLayer", () => {
  const neverFetch = async () => undefined;

  it("detects an unpullable layer in a flat image manifest", async () => {
    expect(await treeHasUnpullableLayer(imageManifest([ZSTD_DOCKER]), neverFetch)).toBe(true);
  });

  it("follows an index and detects an unpullable layer in a child", async () => {
    const children: Record<string, string> = {
      [DIGEST_A]: imageManifest(["application/vnd.oci.image.layer.v1.tar+gzip"]),
      [DIGEST_B]: imageManifest([ZSTD_DOCKER]),
    };
    const result = await treeHasUnpullableLayer(
      indexManifest([DIGEST_A, DIGEST_B]),
      async (digest) => children[digest]
    );
    expect(result).toBe(true);
  });

  it("returns false for an index whose children are all conformant", async () => {
    const children: Record<string, string> = {
      [DIGEST_A]: imageManifest(["application/vnd.oci.image.layer.v1.tar+zstd"]),
      [DIGEST_B]: imageManifest(["application/vnd.docker.image.rootfs.diff.tar.gzip"]),
    };
    const result = await treeHasUnpullableLayer(
      indexManifest([DIGEST_A, DIGEST_B]),
      async (digest) => children[digest]
    );
    expect(result).toBe(false);
  });

  it("fails open when a child manifest can't be fetched", async () => {
    expect(await treeHasUnpullableLayer(indexManifest([DIGEST_A]), neverFetch)).toBe(false);
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

  // Resolve a manifest by tag or digest against a fixture map, mimicking BatchGetImage.
  const sendFrom =
    (byRef: Record<string, string>) =>
    async (input: any): Promise<any> => {
      const id = input.imageIds[0];
      const manifest = byRef[id.imageDigest ?? id.imageTag];
      return manifest ? { images: [{ imageManifest: manifest }] } : { images: [{}] };
    };

  it("returns nonconformant for a single-arch image with an unpullable zstd layer", async () => {
    const result = await ecrImageExists(
      {
        imageReference: `${ECR_HOST}/deployments-test/proj_abc:v1.prod.a1b2c3d4`,
        registryConfig: ecrConfig,
      },
      sendFrom({ "v1.prod.a1b2c3d4": imageManifest([ZSTD_DOCKER]) })
    );
    expect(result).toBe("nonconformant");
  });

  it("returns nonconformant when a multi-arch index has an unpullable child", async () => {
    const result = await ecrImageExists(
      {
        imageReference: `${ECR_HOST}/deployments-test/proj_abc:v1.prod.a1b2c3d4`,
        registryConfig: ecrConfig,
      },
      sendFrom({
        "v1.prod.a1b2c3d4": indexManifest([DIGEST_A, DIGEST_B]),
        [DIGEST_A]: imageManifest(["application/vnd.oci.image.layer.v1.tar+gzip"]),
        [DIGEST_B]: imageManifest([ZSTD_DOCKER]),
      })
    );
    expect(result).toBe("nonconformant");
  });

  it("returns found when a multi-arch index's children are all conformant", async () => {
    const result = await ecrImageExists(
      {
        imageReference: `${ECR_HOST}/deployments-test/proj_abc:v1.prod.a1b2c3d4`,
        registryConfig: ecrConfig,
      },
      sendFrom({
        "v1.prod.a1b2c3d4": indexManifest([DIGEST_A, DIGEST_B]),
        [DIGEST_A]: imageManifest(["application/vnd.oci.image.layer.v1.tar+zstd"]),
        [DIGEST_B]: imageManifest(["application/vnd.docker.image.rootfs.diff.tar.gzip"]),
      })
    );
    expect(result).toBe("found");
  });
});
