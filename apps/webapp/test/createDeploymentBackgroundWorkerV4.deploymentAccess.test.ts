import { randomUUID } from "node:crypto";
import { containerTest } from "@internal/testcontainers";
import type { CreateBackgroundWorkerRequestBody } from "@trigger.dev/core/v3";
import { expect, vi } from "vitest";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import type { DeploymentAccessCheck, DeploymentAccessController } from "@trigger.dev/plugins";
import { CreateDeploymentBackgroundWorkerServiceV4 } from "~/v3/services/createDeploymentBackgroundWorkerV4.server";
import { ServiceValidationError } from "~/v3/services/baseService.server";

vi.setConfig({ testTimeout: 60_000 });

// Catches: a refused task registration leaving the deployment BUILDING or a worker behind,
// instead of failing it with the plugin's message.
containerTest(
  "a refused task registration fails the deployment with the plugin's message, before any worker exists",
  async ({ prisma }) => {
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
        version: "20261102.1",
        status: "BUILDING",
        projectId: project.id,
        environmentId: runtimeEnvironment.id,
      },
    });
    const environment = {
      id: runtimeEnvironment.id,
      type: runtimeEnvironment.type,
      projectId: project.id,
      organizationId: organization.id,
      organization: { id: organization.id, slug: organization.slug, featureFlags: {} },
      project: { id: project.id, engine: "V2", organizationId: organization.id },
    } as unknown as AuthenticatedEnvironment;
    const body: CreateBackgroundWorkerRequestBody = {
      localOnly: false,
      engine: "V2",
      metadata: {
        packageVersion: "4.6.0",
        contentHash: id,
        tasks: [
          { id: "task-a", filePath: "src/trigger/a.ts" },
          { id: "task-b", filePath: "src/trigger/b.ts" },
        ],
      },
    };

    const checks: DeploymentAccessCheck[] = [];
    const deploymentAccess: DeploymentAccessController = {
      async checkDeploy(check) {
        checks.push(check);
        return {
          allowed: false,
          kind: "denied",
          message: `This deployment registers ${check.taskCount} tasks, more than allowed.`,
        };
      },
      async integrationAccess() {
        return { github: true, vercel: true };
      },
    };

    const service = new CreateDeploymentBackgroundWorkerServiceV4(
      prisma,
      prisma,
      undefined,
      undefined,
      deploymentAccess
    );

    const error: unknown = await service.call(environment, deployment.friendlyId, body).then(
      () => undefined,
      (thrown) => thrown
    );
    expect(error).toBeInstanceOf(ServiceValidationError);
    expect((error as Error).message).toBe("This deployment registers 2 tasks, more than allowed.");
    expect(checks).toEqual([
      expect.objectContaining({
        stage: "register_worker",
        organizationId: organization.id,
        deploymentId: deployment.id,
        taskCount: 2,
      }),
    ]);

    const failed = await prisma.workerDeployment.findFirstOrThrow({
      where: { id: deployment.id },
      select: { status: true, errorData: true, workerId: true },
    });
    expect(failed.status).toBe("FAILED");
    expect(failed.workerId).toBeNull();
    expect(JSON.stringify(failed.errorData)).toMatch(/registers 2 tasks/);
    expect(await prisma.backgroundWorker.count({ where: { projectId: project.id } })).toBe(0);
  }
);
