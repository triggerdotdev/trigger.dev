import { minioTest, postgresAndMinioTest } from "@internal/testcontainers";
import { CreateBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { MinIOConnectionConfig } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";
import { ArtifactsService, isArtifactKeyOwnedBy } from "~/v3/services/artifacts.server";

vi.setConfig({ testTimeout: 60_000 });

const owner = { slug: "prod", project: { externalRef: "proj_abc" } };
const ownedKey = `deployments/proj_abc/prod/${"a".repeat(24)}.tar.gz`;

function uniqueSlug() {
  return `s${Math.random().toString(36).slice(2, 10)}`;
}

async function seedBucket(minioConfig: MinIOConnectionConfig) {
  const bucket = `artifacts-${uniqueSlug()}`;
  const client = new S3Client({
    credentials: {
      accessKeyId: minioConfig.accessKeyId,
      secretAccessKey: minioConfig.secretAccessKey,
    },
    region: minioConfig.region,
    endpoint: minioConfig.baseUrl,
    forcePathStyle: true,
  });
  await client.send(new CreateBucketCommand({ Bucket: bucket }));
  return { client, bucket };
}

async function seedDeployment(
  prisma: PrismaClient,
  buildServerMetadata: Record<string, unknown> | undefined,
  type: "PRODUCTION" | "DEVELOPMENT" = "PRODUCTION"
) {
  const slug = uniqueSlug();
  const organization = await prisma.organization.create({ data: { title: slug, slug } });
  const project = await prisma.project.create({
    data: { name: slug, slug, organizationId: organization.id, externalRef: slug },
  });
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      slug,
      type,
      projectId: project.id,
      organizationId: organization.id,
      apiKey: slug,
      pkApiKey: slug,
      shortcode: slug,
    },
  });
  const deployment = await prisma.workerDeployment.create({
    data: {
      friendlyId: `deployment_${slug}`,
      shortCode: slug,
      contentHash: "h",
      status: "INSTALLING",
      version: "20260909.1",
      projectId: project.id,
      environmentId: environment.id,
      buildServerMetadata,
    },
  });
  const authEnv = { id: environment.id, slug, type, project: { externalRef: slug } };
  return { deployment, authEnv, slug };
}

describe("isArtifactKeyOwnedBy", () => {
  minioTest("accepts server-generated keys for the owner only", () => {
    expect(isArtifactKeyOwnedBy(owner, ownedKey)).toBe(true);
    expect(isArtifactKeyOwnedBy(owner, `bundles/proj_abc/prod/${"b".repeat(24)}.tar.gz`)).toBe(
      true
    );
    expect(
      isArtifactKeyOwnedBy(owner, `deployments/proj_other/prod/${"a".repeat(24)}.tar.gz`)
    ).toBe(false);
    expect(
      isArtifactKeyOwnedBy(owner, `deployments/proj_abc/staging/${"a".repeat(24)}.tar.gz`)
    ).toBe(false);
    expect(isArtifactKeyOwnedBy(owner, `deployments/proj_abc/prod/../other.tar.gz`)).toBe(false);
    expect(isArtifactKeyOwnedBy(owner, `other/proj_abc/prod/${"a".repeat(24)}.tar.gz`)).toBe(false);
    expect(isArtifactKeyOwnedBy({ ...owner, slug: "pro.d" }, ownedKey)).toBe(false);
  });
});

describe("ArtifactsService.createDeploymentDownloadUrl", () => {
  postgresAndMinioTest(
    "signs a URL that downloads the artifact",
    async ({ prisma, minioConfig }) => {
      const { client, bucket } = await seedBucket(minioConfig);
      const ttl = 123;
      const service = new ArtifactsService({ prisma, client, bucket, downloadUrlTtlSeconds: ttl });

      const { deployment, authEnv, slug } = await seedDeployment(prisma, undefined);
      const key = `deployments/${slug}/${slug}/${"d".repeat(24)}.tar.gz`;
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: "bundle" }));
      await prisma.workerDeployment.update({
        where: { id: deployment.id },
        data: { buildServerMetadata: { isNativeBuild: true, artifactKey: key } },
      });

      const before = Date.now();
      const { url, expiresAt } = (
        await service.createDeploymentDownloadUrl(authEnv, deployment.friendlyId)
      )._unsafeUnwrap();

      expect(new URL(url).searchParams.get("X-Amz-Expires")).toBe(String(ttl));
      expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + ttl * 1000);
      expect(expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + ttl * 1000);

      const response = await fetch(url);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("bundle");
    }
  );

  postgresAndMinioTest(
    "rejects deployments it must not sign for",
    async ({ prisma, minioConfig }) => {
      const { client, bucket } = await seedBucket(minioConfig);
      const service = new ArtifactsService({ prisma, client, bucket });

      const { deployment, authEnv, slug } = await seedDeployment(prisma, undefined);
      await prisma.workerDeployment.update({
        where: { id: deployment.id },
        data: {
          buildServerMetadata: {
            isNativeBuild: true,
            artifactKey: `deployments/${slug}/${slug}/${"c".repeat(24)}.tar.gz`,
          },
        },
      });

      const missing = await service.createDeploymentDownloadUrl(authEnv, deployment.friendlyId);
      expect(missing._unsafeUnwrapErr()).toEqual({ type: "artifact_not_found" });

      const unknown = await service.createDeploymentDownloadUrl(authEnv, "deployment_nope");
      expect(unknown._unsafeUnwrapErr()).toEqual({ type: "deployment_not_found" });

      const crossEnv = await service.createDeploymentDownloadUrl(
        { ...authEnv, id: "env_other" },
        deployment.friendlyId
      );
      expect(crossEnv._unsafeUnwrapErr()).toEqual({ type: "deployment_not_found" });

      const noKey = await seedDeployment(prisma, { isNativeBuild: false });
      const missingKey = await service.createDeploymentDownloadUrl(
        noKey.authEnv,
        noKey.deployment.friendlyId
      );
      expect(missingKey._unsafeUnwrapErr()).toEqual({ type: "artifact_not_found" });

      const foreignKey = `deployments/proj_other/prod/${"a".repeat(24)}.tar.gz`;
      const foreign = await seedDeployment(prisma, {
        isNativeBuild: true,
        artifactKey: foreignKey,
      });
      const notOwned = await service.createDeploymentDownloadUrl(
        foreign.authEnv,
        foreign.deployment.friendlyId
      );
      expect(notOwned._unsafeUnwrapErr()).toEqual({
        type: "artifact_key_not_owned",
        key: foreignKey,
      });

      const dev = await seedDeployment(prisma, undefined, "DEVELOPMENT");
      const rejected = await service.createDeploymentDownloadUrl(
        dev.authEnv,
        dev.deployment.friendlyId
      );
      expect(rejected._unsafeUnwrapErr()).toEqual({ type: "development_environment" });
    }
  );
});
