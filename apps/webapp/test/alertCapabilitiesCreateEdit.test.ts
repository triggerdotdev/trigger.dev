import { V1_CAPABILITIES, compileTemplate, type AlertCapability } from "@internal/alert-contracts";
import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";
import { encodeErrorGroupScope } from "~/utils/errorGroupScope";
import { applyAlertsMigration } from "./helpers/alertTables";

vi.setConfig({ testTimeout: 120_000 });

vi.mock("~/db.server", () => ({ prisma: {}, $replica: {} }));
vi.mock("~/services/dashboardAgentDb.server", () => ({ dashboardAgentDb: {} }));

const { createAlertFromDraft, InvalidScopeForCapabilityError } =
  await import("~/v3/services/alerts/createAlertFromDraft.server");
const { editAlert } = await import("~/v3/services/alerts/alertActions.server");
const { getAlert } = await import("~/v3/services/alerts/storage/alertStore.server");
const noopDeps = { enqueue: async () => {}, ack: async () => {} };
const { FormSchema, buildCondition, buildScope } = await import("~/v3/services/alerts/alertDraft");

async function boot(prisma: PrismaClient): Promise<PrismaClient> {
  await applyAlertsMigration(prisma);
  return prisma;
}

function suffix() {
  return Math.random().toString(36).slice(2, 10);
}

async function seed(prisma: PrismaClient) {
  const slug = `capabilities_${suffix()}`;
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
      shortcode: `pr${suffix()}`,
    },
  });
  const channel = (name: string) =>
    prisma.projectAlertChannel.create({
      data: {
        friendlyId: `alert_channel_${name}_${slug}`,
        name,
        type: "EMAIL",
        projectId: project.id,
        properties: { email: `${name}@example.com` },
        alertTypes: ["TASK_RUN"],
        environmentTypes: ["PRODUCTION"],
      },
    });
  return {
    organization,
    project,
    environment,
    channel: await channel("first"),
    otherChannel: await channel("second"),
  };
}

function scopeFieldsFor(capability: AlertCapability) {
  if (isErrorGroupOnly(capability)) {
    return {
      scopeType: "errorGroup" as const,
      scopeValue: encodeErrorGroupScope(ERROR_GROUP_SCOPE),
    };
  }
  if (capability.allowedScopes.includes("task")) {
    return { scopeType: "task" as const, scopeValue: "task-a" };
  }
  if (capability.allowedScopes.includes("queue")) {
    return { scopeType: "queue" as const, scopeValue: "queue-a" };
  }
  return { scopeType: "all" as const };
}

const CHECKPOINT_CTX = { checkpoint: "'2026-01-01 00:00:00.000'", after: "1 = 1" };
const ERROR_GROUP_SCOPE = { type: "errorGroup", taskIdentifier: "task-a", fingerprint: "fp-a" };

function isErrorGroupOnly(capability: AlertCapability) {
  return capability.allowedScopes.length === 1 && capability.allowedScopes[0] === "errorGroup";
}

function expectTemplatesCompile(
  capability: AlertCapability,
  conditionParams?: Record<string, number>
) {
  const templates = capability.binding.template
    ? [capability.binding.template]
    : (capability.binding.compositeOf ?? []).map((key) => {
        const template = V1_CAPABILITIES.find((c) => c.key === key)?.binding.template;
        expect(template, `${capability.key} -> ${key}`).toBeTruthy();
        return template!;
      });
  expect(templates.length, capability.key).toBeGreaterThan(0);
  const scopeSql = isErrorGroupOnly(capability)
    ? `task_identifier = '${ERROR_GROUP_SCOPE.taskIdentifier}' AND error_fingerprint = '${ERROR_GROUP_SCOPE.fingerprint}'`
    : "environment_id = 'env_1'";
  for (const template of templates) {
    const sql = compileTemplate(
      template,
      scopeSql,
      conditionParams,
      capability.binding.ctx ? CHECKPOINT_CTX : undefined
    );
    expect(sql, capability.key).not.toMatch(/\{\{/);
  }
}

function draftFor(capability: AlertCapability, channelId: string) {
  const kind = capability.allowedKinds[0];
  const params = capability.binding.params ?? [];
  return FormSchema.parse({
    capabilityKey: capability.key,
    ...scopeFieldsFor(capability),
    conditionKind: kind,
    operator: ">",
    value: 100,
    windowMinutes: Math.max(1, Math.ceil(capability.minCadenceSec / 60)),
    quietWindowMinutes: 60,
    conditionParams:
      kind === "state" && params.length > 0
        ? Object.fromEntries(params.map((p) => [p.key, p.default]))
        : undefined,
    notifierChannelIds: [channelId],
  });
}

describe("alert capabilities create and edit", () => {
  postgresTest("covers every registry capability", async ({ prisma }) => {
    expect(V1_CAPABILITIES).toHaveLength(16);
    expect(new Set(V1_CAPABILITIES.map((c) => c.key)).size).toBe(16);

    const db = await boot(prisma);
    const seeded = await seed(prisma);
    const base = {
      organizationId: seeded.organization.id,
      projectId: seeded.project.id,
      environmentId: seeded.environment.id,
      createdBy: "user_1",
    };

    let created = 0;
    for (const capability of V1_CAPABILITIES) {
      if (isErrorGroupOnly(capability)) {
        expectTemplatesCompile(capability);
        await expect(
          createAlertFromDraft(db, {
            ...base,
            capabilityKey: capability.key,
            scope: { type: "task", taskIdentifier: "task-a" },
            condition: { kind: "occurrence" },
            notifiers: [{ type: "channel", channelId: seeded.channel.id }],
          }),
          capability.key
        ).rejects.toBeInstanceOf(InvalidScopeForCapabilityError);
      }

      const form = draftFor(capability, seeded.channel.id);
      const scope = buildScope(form);
      const condition = buildCondition(form);

      const alert = await createAlertFromDraft(
        db,
        {
          ...base,
          capabilityKey: capability.key,
          scope,
          condition,
          notifiers: form.notifierChannelIds.map((channelId) => ({
            type: "channel" as const,
            channelId,
          })),
        },
        noopDeps
      );
      created++;

      const stored = await getAlert(db, { id: alert.id, projectId: base.projectId });
      expect(stored, capability.key).toMatchObject({
        capabilityKey: capability.key,
        lifecycle: "active",
        params: { environmentId: base.environmentId, scope },
        condition: JSON.parse(JSON.stringify(condition)),
        notifiers: [{ type: "channel", channelId: seeded.channel.id }],
      });
      expect(
        stored!.nextEvaluationAt === null || stored!.nextEvaluationAt instanceof Date,
        capability.key
      ).toBe(true);

      await editAlert(db, {
        alertId: alert.id,
        projectId: base.projectId,
        environmentId: base.environmentId,
        notifiers: [
          { type: "channel", channelId: seeded.otherChannel.id },
          { type: "channel", channelId: seeded.channel.id },
        ],
      });
      const edited = await getAlert(db, { id: alert.id, projectId: base.projectId });
      expect(edited, capability.key).toMatchObject({
        notifiers: [
          { type: "channel", channelId: seeded.otherChannel.id },
          { type: "channel", channelId: seeded.channel.id },
        ],
      });

      expectTemplatesCompile(capability, condition.kind === "state" ? condition.params : undefined);
    }
    expect(created).toBe(V1_CAPABILITIES.length);
  });

  postgresTest("stores a repeated notifier once", async ({ prisma }) => {
    const db = await boot(prisma);
    const seeded = await seed(prisma);
    const capability = V1_CAPABILITIES.find((c) => c.key === "queue.depth")!;
    const form = draftFor(capability, seeded.channel.id);
    const notifier = { type: "channel" as const, channelId: seeded.channel.id };
    const alert = await createAlertFromDraft(
      db,
      {
        organizationId: seeded.organization.id,
        projectId: seeded.project.id,
        environmentId: seeded.environment.id,
        createdBy: "user_1",
        capabilityKey: capability.key,
        scope: buildScope(form),
        condition: buildCondition(form),
        notifiers: [notifier, notifier],
      },
      noopDeps
    );
    const stored = await getAlert(db, { id: alert.id, projectId: seeded.project.id });
    expect(stored!.notifiers).toEqual([notifier]);
  });

  postgresTest("rejects a scope a capability forbids", async ({ prisma }) => {
    const db = await boot(prisma);
    const forbidding = V1_CAPABILITIES.filter((c) => !c.allowedScopes.includes("task"));
    expect(forbidding.length).toBeGreaterThan(0);

    for (const capability of forbidding) {
      const form = draftFor(capability, "chan_1");
      await expect(
        createAlertFromDraft(db, {
          organizationId: "org_1",
          projectId: "proj_1",
          environmentId: "env_1",
          createdBy: "user_1",
          capabilityKey: capability.key,
          scope: { type: "task", taskIdentifier: "task-a" },
          condition: buildCondition(form),
          notifiers: [{ type: "channel", channelId: "chan_1" }],
        }),
        capability.key
      ).rejects.toBeInstanceOf(InvalidScopeForCapabilityError);
    }
  });
});
