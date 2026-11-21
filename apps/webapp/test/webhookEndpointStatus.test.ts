import { postgresTest } from "@internal/testcontainers";
import { expect, vi } from "vitest";
import { updateWebhookEndpointEnabled } from "~/v3/webhookEndpointStatus";

vi.setConfig({ testTimeout: 120_000 });

// Catches: Enable or Disable bringing back an endpoint that is being deleted.
postgresTest(
  "enabling or disabling changes an active or paused endpoint and leaves a deleting one",
  async ({ prisma }) => {
    const setWebhookEndpointEnabled = (endpointId: string, enabled: boolean) =>
      updateWebhookEndpointEnabled(prisma, endpointId, enabled);

    const slug = `endpoint_status_${crypto.randomUUID()}`;
    const organization = await prisma.organization.create({ data: { title: slug, slug } });
    const project = await prisma.project.create({
      data: { name: slug, slug, externalRef: slug, organizationId: organization.id },
    });
    const environment = await prisma.runtimeEnvironment.create({
      data: {
        slug: "prod",
        type: "PRODUCTION",
        projectId: project.id,
        organizationId: organization.id,
        apiKey: `tr_prod_${slug}`,
        pkApiKey: `pk_prod_${slug}`,
        shortcode: "status",
      },
    });
    const createEndpoint = (declaredId: string, status: "ACTIVE" | "DELETING") =>
      prisma.webhookEndpoint.create({
        data: {
          friendlyId: `wh_${crypto.randomUUID()}`,
          opaqueId: crypto.randomUUID(),
          organizationId: organization.id,
          projectId: project.id,
          runtimeEnvironmentId: environment.id,
          environmentType: "PRODUCTION",
          source: "stripe",
          declaredId,
          routingTargets: [],
          verifierArtifact: {},
          status,
        },
      });
    const stateOf = (id: string) =>
      prisma.webhookEndpoint.findFirstOrThrow({
        where: { id },
        select: { status: true, manuallyDeactivatedAt: true },
      });

    const live = await createEndpoint("live", "ACTIVE");
    expect(await setWebhookEndpointEnabled(live.id, false)).toBe(true);
    const paused = await stateOf(live.id);
    expect(paused.status).toBe("INACTIVE");
    expect(paused.manuallyDeactivatedAt).toBeInstanceOf(Date);
    expect(await setWebhookEndpointEnabled(live.id, true)).toBe(true);
    expect(await stateOf(live.id)).toEqual({ status: "ACTIVE", manuallyDeactivatedAt: null });

    const deleting = await createEndpoint("going", "DELETING");
    for (const enabled of [true, false]) {
      expect(await setWebhookEndpointEnabled(deleting.id, enabled)).toBe(false);
      expect(await stateOf(deleting.id)).toEqual({
        status: "DELETING",
        manuallyDeactivatedAt: null,
      });
    }
  }
);
