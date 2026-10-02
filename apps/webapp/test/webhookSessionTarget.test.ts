import { containerTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { resolveWebhookSession } from "~/v3/webhookSessionTarget.server";

vi.setConfig({ testTimeout: 60_000 });

async function seedEnvironment(prisma: PrismaClient) {
  const slug = `wst_${Math.random().toString(36).slice(2, 10)}`;
  const organization = await prisma.organization.create({ data: { title: slug, slug } });
  const project = await prisma.project.create({
    data: { name: slug, slug, organizationId: organization.id, externalRef: slug },
  });
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      slug: "prod",
      type: "PRODUCTION",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_prod_${slug}`,
      pkApiKey: `pk_prod_${slug}`,
      shortcode: `p${slug.slice(0, 5)}`,
    },
  });
  return { ...environment, organization, project } as unknown as AuthenticatedEnvironment;
}

describe("resolveWebhookSession", () => {
  containerTest(
    "rejects a delivery whose session key belongs to another agent and leaves that session untouched",
    async ({ prisma }) => {
      const environment = await seedEnvironment(prisma);

      const primary = await resolveWebhookSession({
        environment,
        externalId: "shared-key",
        taskIdentifier: "session-webhook-primary",
        isSessionStart: true,
        db: prisma,
      });
      expect(primary.kind).toBe("resolved");
      const before = await prisma.session.findFirstOrThrow({ where: { externalId: "shared-key" } });

      const secondary = await resolveWebhookSession({
        environment,
        externalId: "shared-key",
        taskIdentifier: "session-webhook-secondary",
        isSessionStart: true,
        triggerConfigTemplate: { basePayload: { from: "secondary" } },
        db: prisma,
      });

      expect(secondary).toEqual({
        kind: "rejected",
        error:
          'Session "shared-key" belongs to agent "session-webhook-primary", not "session-webhook-secondary"',
      });
      const after = await prisma.session.findFirstOrThrow({ where: { externalId: "shared-key" } });
      expect(after.taskIdentifier).toBe("session-webhook-primary");
      expect(after.triggerConfig).toEqual(before.triggerConfig);
      expect(after.updatedAt).toEqual(before.updatedAt);
    }
  );

  containerTest(
    "concurrent first deliveries from two agents on one key resolve exactly one of them",
    async ({ prisma }) => {
      const environment = await seedEnvironment(prisma);

      const results = await Promise.all(
        ["agent-a", "agent-b"].map((taskIdentifier) =>
          resolveWebhookSession({
            environment,
            externalId: "race-key",
            taskIdentifier,
            isSessionStart: true,
            db: prisma,
          })
        )
      );

      const resolved = results.filter((result) => result.kind === "resolved");
      const rejected = results.filter((result) => result.kind === "rejected");
      expect(resolved).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const session = await prisma.session.findFirstOrThrow({ where: { externalId: "race-key" } });
      if (resolved[0].kind !== "resolved") throw new Error("unreachable");
      expect(resolved[0].session.id).toBe(session.id);
      expect(session.taskIdentifier).toBe(resolved[0].session.taskIdentifier);
    }
  );

  containerTest("the owning agent resumes its existing session", async ({ prisma }) => {
    const environment = await seedEnvironment(prisma);

    const first = await resolveWebhookSession({
      environment,
      externalId: "own-key",
      taskIdentifier: "agent-a",
      isSessionStart: true,
      db: prisma,
    });
    const second = await resolveWebhookSession({
      environment,
      externalId: "own-key",
      taskIdentifier: "agent-a",
      isSessionStart: false,
      db: prisma,
    });

    expect(first.kind).toBe("resolved");
    expect(second.kind).toBe("resolved");
    if (first.kind !== "resolved" || second.kind !== "resolved") return;
    expect(second.session.id).toBe(first.session.id);
    expect(second.isCached).toBe(true);
  });

  containerTest("a non-start event with no session is skipped", async ({ prisma }) => {
    const environment = await seedEnvironment(prisma);

    const result = await resolveWebhookSession({
      environment,
      externalId: "no-session",
      taskIdentifier: "agent-a",
      isSessionStart: false,
      db: prisma,
    });

    expect(result).toEqual({ kind: "skipped", reason: "startOn: not a session-start event" });
    expect(await prisma.session.count({ where: { externalId: "no-session" } })).toBe(0);
  });
});
