import { containerTest } from "@internal/testcontainers";
import { CreateBackgroundWorkerRequestBody } from "@trigger.dev/core/v3";
import { expect } from "vitest";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";

// Catches: a restricted worker registration interpreting omitted declarations as schedule deletions.
containerTest(
  "restricted registration preserves existing declarative resources",
  async ({ prisma, postgresContainer, redisOptions }) => {
    Object.assign(process.env, {
      DATABASE_URL: postgresContainer.getConnectionUri(),
      DIRECT_URL: postgresContainer.getConnectionUri(),
      REDIS_HOST: redisOptions.host,
      REDIS_PORT: String(redisOptions.port),
      REDIS_PASSWORD: redisOptions.password,
      REDIS_TLS_DISABLED: "true",
      SCHEDULE_WORKER_ENABLED: "0",
    });
    const { CreateBackgroundWorkerService } =
      await import("~/v3/services/createBackgroundWorker.server");
    const slug = `restricted_${crypto.randomUUID()}`;
    const organization = await prisma.organization.create({
      data: { title: slug, slug, featureFlags: { hasWebhooksAccess: true } },
    });
    const project = await prisma.project.create({
      data: { name: slug, slug, externalRef: slug, organizationId: organization.id },
    });
    const environment = await prisma.runtimeEnvironment.create({
      data: {
        slug: "dev",
        type: "DEVELOPMENT",
        projectId: project.id,
        organizationId: organization.id,
        apiKey: `tr_dev_${slug}`,
        pkApiKey: `pk_dev_${slug}`,
        shortcode: "restrict",
      },
    });
    const schedule = await prisma.taskSchedule.create({
      data: {
        friendlyId: `sched_${crypto.randomUUID()}`,
        taskIdentifier: "scheduled-task",
        projectId: project.id,
        generatorExpression: "0 * * * *",
        generatorDescription: "every hour",
        type: "DECLARATIVE",
        instances: { create: { environmentId: environment.id, projectId: project.id } },
      },
      include: { instances: true },
    });
    const endpoint = await prisma.webhookEndpoint.create({
      data: {
        friendlyId: `wh_${crypto.randomUUID()}`,
        opaqueId: crypto.randomUUID(),
        organizationId: organization.id,
        projectId: project.id,
        runtimeEnvironmentId: environment.id,
        environmentType: "DEVELOPMENT",
        source: "stripe",
        declaredId: "existing-endpoint",
        routingTargets: [],
        verifierArtifact: {},
        status: "ACTIVE",
      },
    });
    const body = CreateBackgroundWorkerRequestBody.parse({
      engine: "V2",
      localOnly: true,
      metadata: {
        contentHash: "restricted-registration",
        packageVersion: "4.0.0",
        cliPackageVersion: "4.0.0",
        tasks: [],
        queues: [],
        sourceFiles: [],
      },
    });
    const worker = await new CreateBackgroundWorkerService(prisma, prisma).call(
      project.externalRef,
      { ...environment, project, organization, orgMember: null } as AuthenticatedEnvironment,
      body,
      { restricted: true }
    );

    expect(worker.runtimeEnvironmentId).toBe(environment.id);
    expect(
      await prisma.taskSchedule.findFirst({
        where: { id: schedule.id },
        include: { instances: true },
      })
    ).toEqual(schedule);
    expect(await prisma.webhookEndpoint.findFirst({ where: { id: endpoint.id } })).toEqual(
      endpoint
    );
  }
);
