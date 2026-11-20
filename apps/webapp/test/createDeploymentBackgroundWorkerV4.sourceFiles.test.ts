import { randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";
import { postgresAndMinioTest, type MinIOConnectionConfig } from "@internal/testcontainers";
import { AwsClient } from "aws4fetch";
import type { CreateBackgroundWorkerRequestBody } from "@trigger.dev/core/v3";
import { expect, vi } from "vitest";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { captureDeploymentIndex, DeploymentIndexStore } from "~/v3/deploymentIndex.server";
import { ObjectStoreClient } from "~/v3/objectStoreClient.server";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import { CreateDeploymentBackgroundWorkerServiceV4 } from "~/v3/services/createDeploymentBackgroundWorkerV4.server";

vi.setConfig({ testTimeout: 60_000 });

const BUCKET = "packets";

function indexStore(minioConfig: MinIOConnectionConfig) {
  const client = ObjectStoreClient.create({ ...minioConfig, bucket: BUCKET, service: "s3" });
  return new DeploymentIndexStore({
    root: BUCKET,
    clientFor: () => client,
    maxAttempts: 3,
    minRetryTimeoutMs: 1,
  });
}

async function storedObjectCount(minioConfig: MinIOConnectionConfig) {
  const aws = new AwsClient({
    accessKeyId: minioConfig.accessKeyId,
    secretAccessKey: minioConfig.secretAccessKey,
    region: minioConfig.region,
    service: "s3",
  });
  const response = await aws.fetch(`${minioConfig.baseUrl}/${BUCKET}?list-type=2`);
  return ((await response.text()).match(/<Key>/g) ?? []).length;
}

// Catches: oversized source reaching the deployment index or the database, or leaving the
// deployment BUILDING instead of failing it with the reason.
postgresAndMinioTest(
  "oversized source fails the deployment before the index, worker or files are written",
  async ({ prisma, minioConfig }) => {
    await prisma.featureFlag.create({
      data: { key: "deploymentIndexCaptureEnabled", value: true },
    });
    const id = randomUUID();
    const organization = await prisma.organization.create({
      data: { title: "Org", slug: id, createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    });
    const project = await prisma.project.create({
      data: {
        name: "Project",
        slug: id,
        externalRef: `proj_${id}`,
        organizationId: organization.id,
        engine: "V2",
      },
    });
    const runtimeEnvironment = await prisma.runtimeEnvironment.create({
      data: {
        slug: "prod",
        type: "PRODUCTION",
        apiKey: id,
        pkApiKey: id,
        shortcode: id,
        projectId: project.id,
        organizationId: organization.id,
      },
    });
    const deployment = await prisma.workerDeployment.create({
      data: {
        friendlyId: `deployment_${id}`,
        shortCode: id,
        contentHash: id,
        version: "20261117.1",
        status: "BUILDING",
        projectId: project.id,
        environmentId: runtimeEnvironment.id,
      },
    });
    const environment = {
      id: runtimeEnvironment.id,
      slug: runtimeEnvironment.slug,
      type: runtimeEnvironment.type,
      projectId: project.id,
      organizationId: organization.id,
      organization: { id: organization.id, slug: organization.slug, featureFlags: {} },
      project: {
        id: project.id,
        externalRef: project.externalRef,
        engine: "V2",
        organizationId: organization.id,
      },
    } as unknown as AuthenticatedEnvironment;
    const body: CreateBackgroundWorkerRequestBody = {
      localOnly: false,
      engine: "V2",
      metadata: {
        packageVersion: "4.6.0",
        contentHash: id,
        tasks: [{ id: "task-a", filePath: "src/trigger/a.ts" }],
        sourceFiles: [
          {
            filePath: "src/trigger/a.ts",
            contentHash: `${id}-file`,
            contents: deflateSync(Buffer.alloc(64 * 1024 * 1024)).toString("base64"),
            taskIds: ["task-a"],
          },
        ],
      },
    };

    const store = indexStore(minioConfig);
    const service = new CreateDeploymentBackgroundWorkerServiceV4(
      prisma,
      prisma,
      undefined,
      store,
      null
    );

    const error = await service.call(environment, deployment.friendlyId, body).catch((e) => e);

    expect(error).toBeInstanceOf(ServiceValidationError);
    expect(error.status).toBe(413);
    expect(error.message).toContain('"src/trigger/a.ts"');
    expect(await storedObjectCount(minioConfig)).toBe(0);

    const failed = await prisma.workerDeployment.findFirstOrThrow({
      where: { id: deployment.id },
      select: { status: true, errorData: true, workerId: true },
    });
    expect(failed.status).toBe("FAILED");
    expect(failed.workerId).toBeNull();
    expect(JSON.stringify(failed.errorData)).toContain("src/trigger/a.ts");
    expect(await prisma.backgroundWorker.count({ where: { projectId: project.id } })).toBe(0);
    expect(await prisma.backgroundWorkerFile.count({ where: { projectId: project.id } })).toBe(0);

    // Capture is on and writes to this bucket, so the empty listing above is meaningful.
    await captureDeploymentIndex(
      environment,
      deployment,
      { ...body, metadata: { ...body.metadata, sourceFiles: [] } },
      store,
      prisma
    );
    expect(await storedObjectCount(minioConfig)).toBe(1);
  }
);
