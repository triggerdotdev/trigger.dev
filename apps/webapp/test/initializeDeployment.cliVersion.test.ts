import { containerTest } from "@internal/testcontainers";
import { setupAuthenticatedEnvironment } from "@internal/run-engine/tests";
import type { InitializeDeploymentRequestBody } from "@trigger.dev/core/v3";
import { expect, vi } from "vitest";
import { alertsWorker } from "~/v3/alertsWorker.server";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import { InitializeDeploymentService } from "~/v3/services/initializeDeployment.server";

vi.setConfig({ testTimeout: 60_000 });

// Catches: a rejected deploy leaving no FAILED row or alert, or cancelling the deploy it would replace.
containerTest(
  "fails a new deployment from an old CLI without cancelling the running one",
  async ({ prisma }) => {
    const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
    const running = await prisma.workerDeployment.create({
      data: {
        friendlyId: "deployment_running",
        shortCode: "running",
        contentHash: "hash_running",
        status: "BUILDING",
        version: "20260101.1",
        externalId: "ext",
        projectId: environment.projectId,
        environmentId: environment.id,
      },
    });

    const service = new InitializeDeploymentService(
      prisma,
      prisma,
      null,
      async () => undefined,
      () => ({ minimum: "4.5.20", enforcedFrom: new Date("2026-01-01T00:00:00Z") })
    );
    const error = await service
      .call(
        environment,
        {
          type: "MANAGED",
          contentHash: "hash_new",
          externalId: "ext",
          force: true,
        } as InitializeDeploymentRequestBody,
        { initiatedByCredential: null, cliVersion: "4.5.19" }
      )
      .catch((thrown) => thrown);

    expect(error).toBeInstanceOf(ServiceValidationError);
    expect(error).toMatchObject({ status: 400 });
    expect(error.message).toContain("4.5.20");

    const rejected = await prisma.workerDeployment.findFirstOrThrow({
      where: { environmentId: environment.id, contentHash: "hash_new" },
    });
    expect(rejected).toMatchObject({
      status: "FAILED",
      cliVersion: "4.5.19",
      errorData: { name: "Unsupported trigger.dev version" },
    });
    expect(alertsWorker.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        job: "v3.performDeploymentAlerts",
        payload: { deploymentId: rejected.id },
      })
    );

    const stillRunning = await prisma.workerDeployment.findFirstOrThrow({
      where: { id: running.id },
    });
    expect(stillRunning.status).toBe("BUILDING");
  }
);
