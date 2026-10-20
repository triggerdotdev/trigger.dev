import { postgresTest } from "@internal/testcontainers";
import type { Prisma, RuntimeEnvironmentType } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";
import { alertChannelIssues, loadNotifierChannels } from "./alertChannelIssues.server";
import { findValidNotifierChannelIds } from "./validateNotifierChannels.server";

vi.setConfig({ testTimeout: 120_000 });

type Fixture = {
  name: string;
  type: "EMAIL" | "SLACK" | "WEBHOOK";
  enabled: boolean;
  environmentTypes: RuntimeEnvironmentType[];
  withIntegration?: boolean;
  jsonIntegration?: "valid" | "empty" | "null";
};

const FIXTURES: Fixture[] = [
  { name: "email-ok", type: "EMAIL", enabled: true, environmentTypes: ["PRODUCTION"] },
  { name: "email-disabled", type: "EMAIL", enabled: false, environmentTypes: ["PRODUCTION"] },
  { name: "email-staging", type: "EMAIL", enabled: true, environmentTypes: ["STAGING"] },
  { name: "webhook-ok", type: "WEBHOOK", enabled: true, environmentTypes: ["PRODUCTION"] },
  { name: "slack-no-integration", type: "SLACK", enabled: true, environmentTypes: ["PRODUCTION"] },
  {
    name: "slack-ok",
    type: "SLACK",
    enabled: true,
    environmentTypes: ["PRODUCTION"],
    withIntegration: true,
  },
  {
    name: "slack-json-only",
    type: "SLACK",
    enabled: true,
    environmentTypes: ["PRODUCTION"],
    jsonIntegration: "valid",
  },
  {
    name: "slack-json-empty",
    type: "SLACK",
    enabled: true,
    environmentTypes: ["PRODUCTION"],
    jsonIntegration: "empty",
  },
  {
    name: "slack-json-null",
    type: "SLACK",
    enabled: true,
    environmentTypes: ["PRODUCTION"],
    jsonIntegration: "null",
  },
  {
    name: "slack-disabled-staging",
    type: "SLACK",
    enabled: false,
    environmentTypes: ["STAGING"],
    withIntegration: true,
  },
];

describe("alertChannelIssues matches findValidNotifierChannelIds", () => {
  postgresTest("a channel has an issue exactly when it is not deliverable", async ({ prisma }) => {
    const slug = `p${Math.random().toString(36).slice(2, 10)}`;
    const organization = await prisma.organization.create({ data: { title: slug, slug } });
    const project = await prisma.project.create({
      data: { name: slug, slug, organizationId: organization.id, externalRef: `proj_${slug}` },
    });
    const environment = await prisma.runtimeEnvironment.create({
      data: {
        slug: "prod",
        type: "PRODUCTION",
        projectId: project.id,
        organizationId: organization.id,
        apiKey: `tr_prod_${slug}`,
        pkApiKey: `pk_prod_${slug}`,
        shortcode: slug,
      },
    });
    const secret = await prisma.secretReference.create({ data: { key: `slack_${slug}` } });
    const integration = await prisma.organizationIntegration.create({
      data: {
        friendlyId: `int_${slug}`,
        service: "SLACK",
        integrationData: {},
        tokenReferenceId: secret.id,
        organizationId: organization.id,
      },
    });

    const channels = await Promise.all(
      FIXTURES.map((f) =>
        prisma.projectAlertChannel.create({
          data: {
            friendlyId: `alert_channel_${f.name}_${slug}`,
            name: f.name,
            type: f.type,
            enabled: f.enabled,
            environmentTypes: f.environmentTypes,
            integrationId: f.withIntegration ? integration.id : null,
            projectId: project.id,
            properties: ({
              valid: { integrationId: integration.id },
              empty: { integrationId: "" },
              null: { integrationId: null },
            }[f.jsonIntegration ?? "none"] ?? {}) as Prisma.InputJsonValue,
            alertTypes: [],
          },
        })
      )
    );
    const ids = channels.map((c) => c.id);

    const valid = new Set(
      await findValidNotifierChannelIds(prisma, project.id, ids, environment.type)
    );
    const loaded = await loadNotifierChannels(prisma, {
      projectId: project.id,
      environmentId: environment.id,
      channelIds: ids,
    });
    expect(loaded.environmentType).toBe("PRODUCTION");

    const table = channels.map((c) => ({
      name: c.name,
      notDeliverable: !valid.has(c.id),
      hasIssue:
        alertChannelIssues(
          [{ type: "channel", channelId: c.id }],
          loaded.channels,
          loaded.environmentType
        ).length > 0,
    }));
    for (const row of table) {
      expect(row.hasIssue, row.name).toBe(row.notDeliverable);
    }
    expect(table.filter((r) => !r.notDeliverable).map((r) => r.name)).toEqual([
      "email-ok",
      "webhook-ok",
      "slack-ok",
      "slack-json-only",
    ]);
  });
});
