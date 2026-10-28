import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect, it, vi } from "vitest";

import {
  findStartedSession,
  startedSessionExternalId,
  traceRootRunId,
} from "~/presenters/v3/startedSession.server";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

async function seed(prisma: PrismaClient) {
  const organization = await prisma.organization.create({
    data: { title: "Org", slug: "org" },
  });
  const project = await prisma.project.create({
    data: {
      name: "Project",
      slug: "project",
      externalRef: "proj_started_session",
      organizationId: organization.id,
    },
  });

  const createUser = async (suffix: string) => {
    const user = await prisma.user.create({
      data: { email: `${suffix}@example.com`, authenticationMethod: "MAGIC_LINK" },
    });
    const member = await prisma.orgMember.create({
      data: { userId: user.id, organizationId: organization.id, role: "ADMIN" },
    });
    return { user, member };
  };

  const createEnvironment = (
    slug: string,
    options: { type?: "PRODUCTION" | "DEVELOPMENT"; orgMemberId?: string } = {}
  ) =>
    prisma.runtimeEnvironment.create({
      data: {
        type: options.type ?? "PRODUCTION",
        slug,
        projectId: project.id,
        organizationId: organization.id,
        apiKey: `tr_${slug}`,
        pkApiKey: `pk_${slug}`,
        shortcode: `short_${slug}`,
        orgMemberId: options.orgMemberId,
      },
    });

  const createSession = (
    environment: { id: string; type: "PRODUCTION" | "DEVELOPMENT" },
    friendlyId: string,
    externalId: string,
    timestamps: { closedAt?: Date; expiresAt?: Date } = {}
  ) =>
    prisma.session.create({
      data: {
        friendlyId,
        externalId,
        ...timestamps,
        type: "chat.agent",
        projectId: project.id,
        runtimeEnvironmentId: environment.id,
        environmentType: environment.type,
        organizationId: organization.id,
        taskIdentifier: "sub-agent",
        triggerConfig: { basePayload: {} },
        currentRunVersion: 0,
      },
    });

  return { createUser, createEnvironment, createSession };
}

describe("startedSessionExternalId", () => {
  it("reads externalId from a sessions.start() span", () => {
    expect(
      startedSessionExternalId({
        message: "sessions.start()",
        properties: { session: "chat_1", externalId: "chat_1", type: "chat.agent" },
      })
    ).toBe("chat_1");
  });

  it("ignores the session attribute, which falls back to the type without an externalId", () => {
    expect(
      startedSessionExternalId({
        message: "sessions.start()",
        properties: { session: "chat.agent", type: "chat.agent" },
      })
    ).toBeUndefined();
  });

  it("ignores other spans, empty ids and non-object properties", () => {
    expect(
      startedSessionExternalId({ message: "sessions.retrieve()", properties: { externalId: "x" } })
    ).toBeUndefined();
    expect(
      startedSessionExternalId({ message: "sessions.start()", properties: { externalId: "" } })
    ).toBeUndefined();
    expect(
      startedSessionExternalId({ message: "sessions.start()", properties: "externalId" })
    ).toBeUndefined();
    expect(
      startedSessionExternalId({ message: "sessions.start()", properties: undefined })
    ).toBeUndefined();
  });
});

describe("traceRootRunId", () => {
  it("uses the root run for a child run, so its spans resolve to the trace's session", () => {
    expect(traceRootRunId({ id: "child_run", rootTaskRunId: "session_root_run" })).toBe(
      "session_root_run"
    );
  });

  it("uses the run itself when it is the root", () => {
    expect(traceRootRunId({ id: "session_root_run", rootTaskRunId: null })).toBe(
      "session_root_run"
    );
  });
});

describe("findStartedSession", () => {
  postgresTest("links a session started from a plain task", async ({ prisma }) => {
    const { createUser, createEnvironment, createSession } = await seed(prisma);
    const { user } = await createUser("viewer");
    const environment = await createEnvironment("prod");
    const child = await createSession(environment, "session_child", "chat_child");

    const result = await findStartedSession(prisma, {
      environmentId: environment.id,
      externalId: "chat_child",
      rootRunId: "run_plain_task",
      userId: user.id,
    });

    expect(result).toEqual({
      friendlyId: child.friendlyId,
      externalId: "chat_child",
      status: "ACTIVE",
      isCurrent: false,
    });
  });

  postgresTest("links a sub-agent session started by another session's run", async ({ prisma }) => {
    const { createUser, createEnvironment, createSession } = await seed(prisma);
    const { user } = await createUser("viewer");
    const environment = await createEnvironment("prod");
    const parent = await createSession(environment, "session_parent", "chat_parent");
    await createSession(environment, "session_child", "chat_child");
    await prisma.sessionRun.create({
      data: { sessionId: parent.id, runId: "orchestrator_run", reason: "initial" },
    });

    const result = await findStartedSession(prisma, {
      environmentId: environment.id,
      externalId: "chat_child",
      rootRunId: "orchestrator_run",
      userId: user.id,
    });

    expect(result?.friendlyId).toBe("session_child");
    expect(result?.isCurrent).toBe(false);
  });

  postgresTest("marks the session of the trace's root run as current", async ({ prisma }) => {
    const { createUser, createEnvironment, createSession } = await seed(prisma);
    const { user } = await createUser("viewer");
    const environment = await createEnvironment("prod");
    const own = await createSession(environment, "session_own", "chat_own");
    await prisma.sessionRun.create({
      data: { sessionId: own.id, runId: "session_root_run", reason: "initial" },
    });

    const result = await findStartedSession(prisma, {
      environmentId: environment.id,
      externalId: "chat_own",
      rootRunId: "session_root_run",
      userId: user.id,
    });

    expect(result?.friendlyId).toBe("session_own");
    expect(result?.isCurrent).toBe(true);
  });

  postgresTest("reports closed and expired sessions", async ({ prisma }) => {
    const { createUser, createEnvironment, createSession } = await seed(prisma);
    const { user } = await createUser("viewer");
    const environment = await createEnvironment("prod");
    await createSession(environment, "session_closed", "chat_closed", { closedAt: new Date() });
    await createSession(environment, "session_expired", "chat_expired", {
      expiresAt: new Date(Date.now() - 60_000),
    });

    const lookup = (externalId: string) =>
      findStartedSession(prisma, {
        environmentId: environment.id,
        externalId,
        rootRunId: "run_plain_task",
        userId: user.id,
      });

    expect((await lookup("chat_closed"))?.status).toBe("CLOSED");
    expect((await lookup("chat_expired"))?.status).toBe("EXPIRED");
  });

  postgresTest("returns nothing when no session matches in the environment", async ({ prisma }) => {
    const { createUser, createEnvironment, createSession } = await seed(prisma);
    const { user } = await createUser("viewer");
    const environment = await createEnvironment("prod");
    const other = await createEnvironment("staging");
    await createSession(other, "session_elsewhere", "chat_child");

    const result = await findStartedSession(prisma, {
      environmentId: environment.id,
      externalId: "chat_child",
      rootRunId: "run_plain_task",
      userId: user.id,
    });

    expect(result).toBeUndefined();
  });

  postgresTest(
    "resolves dev environment sessions for the environment's owner only",
    async ({ prisma }) => {
      const { createUser, createEnvironment, createSession } = await seed(prisma);
      const owner = await createUser("owner");
      const teammate = await createUser("teammate");
      const dev = await createEnvironment("dev", {
        type: "DEVELOPMENT",
        orgMemberId: owner.member.id,
      });
      await createSession(dev, "session_dev", "chat_dev");

      const lookup = (userId: string) =>
        findStartedSession(prisma, {
          environmentId: dev.id,
          externalId: "chat_dev",
          rootRunId: "run_plain_task",
          userId,
        });

      expect((await lookup(owner.user.id))?.friendlyId).toBe("session_dev");
      expect(await lookup(teammate.user.id)).toBeUndefined();
    }
  );
});
