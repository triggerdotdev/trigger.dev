import { postgresTest } from "@internal/testcontainers";
import { expect, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });
import { generateFriendlyId } from "~/v3/friendlyIdentifiers";
import { findValidNotifierChannelIds } from "./validateNotifierChannels.server";

postgresTest("only returns channel ids that belong to the project", async ({ prisma }) => {
  const organization = await prisma.organization.create({
    data: { slug: "notifier-channels", title: "Notifier channels" },
  });
  const project = await prisma.project.create({
    data: {
      slug: "notifier-channels",
      name: "Notifier channels",
      externalRef: "notifier-channels",
      organizationId: organization.id,
    },
  });
  const otherProject = await prisma.project.create({
    data: {
      slug: "notifier-channels-other",
      name: "Notifier channels other",
      externalRef: "notifier-channels-other",
      organizationId: organization.id,
    },
  });

  const ownChannel = await prisma.projectAlertChannel.create({
    data: {
      friendlyId: generateFriendlyId("alert_channel"),
      projectId: project.id,
      type: "EMAIL",
      name: "Own channel",
      properties: { email: "a@example.test" },
      alertTypes: ["TASK_RUN"],
    },
  });
  const foreignChannel = await prisma.projectAlertChannel.create({
    data: {
      friendlyId: generateFriendlyId("alert_channel"),
      projectId: otherProject.id,
      type: "EMAIL",
      name: "Foreign channel",
      properties: { email: "b@example.test" },
      alertTypes: ["TASK_RUN"],
    },
  });

  const valid = await findValidNotifierChannelIds(
    prisma,
    project.id,
    [ownChannel.id],
    "PRODUCTION"
  );
  expect(valid).toEqual([ownChannel.id]);

  const withForeign = await findValidNotifierChannelIds(
    prisma,
    project.id,
    [ownChannel.id, foreignChannel.id],
    "PRODUCTION"
  );
  expect(withForeign).toEqual([ownChannel.id]);

  expect(await findValidNotifierChannelIds(prisma, project.id, [], "PRODUCTION")).toEqual([]);
});

postgresTest("excludes disabled channels", async ({ prisma }) => {
  const organization = await prisma.organization.create({
    data: { slug: "notifier-channels-disabled", title: "Notifier channels disabled" },
  });
  const project = await prisma.project.create({
    data: {
      slug: "notifier-channels-disabled",
      name: "Notifier channels disabled",
      externalRef: "notifier-channels-disabled",
      organizationId: organization.id,
    },
  });

  const enabledChannel = await prisma.projectAlertChannel.create({
    data: {
      friendlyId: generateFriendlyId("alert_channel"),
      projectId: project.id,
      type: "EMAIL",
      name: "Enabled channel",
      properties: { email: "enabled@example.test" },
      alertTypes: ["TASK_RUN"],
      enabled: true,
    },
  });
  const disabledChannel = await prisma.projectAlertChannel.create({
    data: {
      friendlyId: generateFriendlyId("alert_channel"),
      projectId: project.id,
      type: "EMAIL",
      name: "Disabled channel",
      properties: { email: "disabled@example.test" },
      alertTypes: ["TASK_RUN"],
      enabled: false,
    },
  });

  const valid = await findValidNotifierChannelIds(
    prisma,
    project.id,
    [enabledChannel.id, disabledChannel.id],
    "PRODUCTION"
  );

  expect(valid).toEqual([enabledChannel.id]);
});

postgresTest("rejects undeliverable channels and accepts a matching one", async ({ prisma }) => {
  const organization = await prisma.organization.create({
    data: { slug: "notifier-deliverable", title: "Notifier deliverable" },
  });
  const project = await prisma.project.create({
    data: {
      slug: "notifier-deliverable",
      name: "Notifier deliverable",
      externalRef: "notifier-deliverable",
      organizationId: organization.id,
    },
  });

  const make = (name: string, data: Record<string, unknown>) =>
    prisma.projectAlertChannel.create({
      data: {
        friendlyId: generateFriendlyId("alert_channel"),
        projectId: project.id,
        type: "EMAIL",
        name,
        properties: { email: `${name}@example.test` },
        alertTypes: ["TASK_RUN"],
        ...data,
      },
    });

  const good = await make("good", {});
  const disabled = await make("disabled", { enabled: false });
  const wrongEnv = await make("wrong-env", { environmentTypes: ["DEVELOPMENT"] });
  const slackNoIntegration = await make("slack", { type: "SLACK", integrationId: null });

  const ids = [good.id, disabled.id, wrongEnv.id, slackNoIntegration.id];
  expect(await findValidNotifierChannelIds(prisma, project.id, ids, "PRODUCTION")).toEqual([
    good.id,
  ]);
  expect(await findValidNotifierChannelIds(prisma, project.id, ids, "DEVELOPMENT")).toEqual([
    wrongEnv.id,
  ]);
});

postgresTest("accepts a Slack channel that has an integration", async ({ prisma }) => {
  const organization = await prisma.organization.create({
    data: { slug: "notifier-slack", title: "Notifier slack" },
  });
  const project = await prisma.project.create({
    data: {
      slug: "notifier-slack",
      name: "Notifier slack",
      externalRef: "notifier-slack",
      organizationId: organization.id,
    },
  });
  const secret = await prisma.secretReference.create({ data: { key: "notifier-slack-token" } });
  const integration = await prisma.organizationIntegration.create({
    data: {
      friendlyId: generateFriendlyId("org_integration"),
      service: "SLACK",
      integrationData: {},
      tokenReferenceId: secret.id,
      organizationId: organization.id,
    },
  });
  const slack = await prisma.projectAlertChannel.create({
    data: {
      friendlyId: generateFriendlyId("alert_channel"),
      projectId: project.id,
      type: "SLACK",
      name: "slack",
      properties: {},
      alertTypes: ["TASK_RUN"],
      integrationId: integration.id,
    },
  });

  expect(await findValidNotifierChannelIds(prisma, project.id, [slack.id], "PRODUCTION")).toEqual([
    slack.id,
  ]);
});
