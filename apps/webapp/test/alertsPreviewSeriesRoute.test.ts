import { postgresTest } from "@internal/testcontainers";
import { expect, vi } from "vitest";
import {
  loadPreviewSeries,
  MAX_WINDOW_MINUTES,
  type PreviewSeriesResponse,
} from "~/v3/services/alerts/previewSeries.server";

vi.setConfig({ testTimeout: 60_000 });

async function seedOrgProjectEnv(
  prisma: any,
  suffix: string,
  featureFlags: Record<string, unknown> = { alertsEnabled: true }
) {
  const user = await prisma.user.create({
    data: { email: `preview-series-${suffix}@example.test`, authenticationMethod: "MAGIC_LINK" },
  });
  const organization = await prisma.organization.create({
    data: {
      slug: `preview-series-${suffix}`,
      title: `Preview series ${suffix}`,
      featureFlags,
      members: { create: { userId: user.id, role: "ADMIN" } },
    },
  });
  const project = await prisma.project.create({
    data: {
      slug: `preview-series-${suffix}`,
      name: `Preview series ${suffix}`,
      externalRef: `preview-series-${suffix}`,
      organizationId: organization.id,
    },
  });
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      slug: `preview-series-${suffix}`,
      type: "PRODUCTION",
      organizationId: organization.id,
      projectId: project.id,
      apiKey: `tr_preview_series_${suffix}`,
      pkApiKey: `pk_preview_series_${suffix}`,
      shortcode: `preview-series-${suffix}`,
    },
  });
  return { user, organization, project, environment };
}

const noopRunner = async () => [] as Record<string, unknown>[];

postgresTest("returns series for queue.depth in the caller's env", async ({ prisma }) => {
  const { user, organization, project, environment } = await seedOrgProjectEnv(prisma, "ok");

  const result = await loadPreviewSeries(
    {
      userId: user.id,
      organizationSlug: organization.slug,
      projectParam: project.slug,
      envParam: environment.slug,
      capabilityKey: "queue.depth",
      scopeType: "all",
    },
    { runner: noopRunner, db: prisma }
  );

  expect(result.status).toBe(200);
  const body = result.body as PreviewSeriesResponse;
  expect(body.series.length).toBeGreaterThan(0);
  expect(body.series[0]!.key).toBe("__agg__");
  expect(body.bucketSec).toBe(300);
  expect(body.windowSec).toBe(720 * 60);
});

postgresTest("400 on unknown capability", async ({ prisma }) => {
  const { user, organization, project, environment } = await seedOrgProjectEnv(prisma, "unknown");

  const result = await loadPreviewSeries(
    {
      userId: user.id,
      organizationSlug: organization.slug,
      projectParam: project.slug,
      envParam: environment.slug,
      capabilityKey: "not.a.real.capability",
      scopeType: "all",
    },
    { runner: noopRunner, db: prisma }
  );

  expect(result.status).toBe(400);
});

postgresTest("denies another org's env", async ({ prisma }) => {
  const {
    organization: otherOrg,
    project: otherProject,
    environment: otherEnv,
  } = await seedOrgProjectEnv(prisma, "other");
  const { user: outsider } = await seedOrgProjectEnv(prisma, "outsider");

  const result = await loadPreviewSeries(
    {
      userId: outsider.id,
      organizationSlug: otherOrg.slug,
      projectParam: otherProject.slug,
      envParam: otherEnv.slug,
      capabilityKey: "queue.depth",
      scopeType: "all",
    },
    { runner: noopRunner, db: prisma }
  );

  expect(result.status).toBe(404);
});

postgresTest("fails when windowMinutes above the cap is accepted", async ({ prisma }) => {
  const { user, organization, project, environment } = await seedOrgProjectEnv(prisma, "cap");

  const result = await loadPreviewSeries(
    {
      userId: user.id,
      organizationSlug: organization.slug,
      projectParam: project.slug,
      envParam: environment.slug,
      capabilityKey: "queue.depth",
      scopeType: "all",
      windowMinutes: MAX_WINDOW_MINUTES * 10,
    },
    { runner: noopRunner, db: prisma }
  );

  expect(result.status).toBe(200);
  const body = result.body as PreviewSeriesResponse;
  expect(body.windowSec).toBe(MAX_WINDOW_MINUTES * 60);
});
