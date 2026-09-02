/**
 * A run's commit resolves for any project inside an org-claim token's organization, so the agent
 * can follow a run it found in a sibling project. Cross-org stays refused, and a token with only
 * an environment claim is unchanged.
 */

import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { signUserActorToken } from "@trigger.dev/rbac";
import { expect, vi } from "vitest";

const SESSION_SECRET = "test-session-secret";

const ctx = vi.hoisted(() => ({ prisma: undefined as unknown as PrismaClient }));

vi.mock("~/db.server", () => {
  const proxy = new Proxy(
    {},
    { get: (_target, prop) => (ctx.prisma as unknown as Record<string, unknown>)[prop as string] }
  );
  return { prisma: proxy, $replica: proxy, sqlDatabaseSchema: undefined };
});
vi.mock("~/env.server", () => ({ env: { SESSION_SECRET: "test-session-secret" } }));
vi.mock("~/services/logger.server", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
// The run store shards across databases; the commit lookup only needs the run's locked version.
vi.mock("~/v3/runStore.server", () => ({
  runStore: {
    findRunOnPrimary: async (where: Record<string, unknown>, opts: { select: any }) =>
      ctx.prisma.taskRun.findFirst({ where: where as any, select: opts.select }),
  },
}));

const { loader } = await import("~/routes/api.v1.projects.$projectRef.$env.runs.$runId.commit");
const { authenticatedEnvironmentForAuthentication } = await import("~/services/apiAuth.server");

function suffix() {
  return Math.random().toString(36).slice(2, 10);
}

/** An org with two projects, each with a prod environment holding one deployed, pinned run. */
async function seedOrg(prisma: PrismaClient) {
  const slug = `runcommit_${suffix()}`;
  const member = await prisma.user.create({
    data: { email: `${slug}-member@example.com`, authenticationMethod: "MAGIC_LINK" },
  });
  const organization = await prisma.organization.create({ data: { title: slug, slug } });
  await prisma.orgMember.create({
    data: { organizationId: organization.id, userId: member.id, role: "ADMIN" },
  });

  async function projectWithRun(name: string) {
    const projectSlug = `${slug}_${name}`;
    const project = await prisma.project.create({
      data: {
        name: projectSlug,
        slug: projectSlug,
        organizationId: organization.id,
        externalRef: `proj_${projectSlug}`,
      },
    });
    const environment = await prisma.runtimeEnvironment.create({
      data: {
        slug: "prod",
        type: "PRODUCTION",
        projectId: project.id,
        organizationId: organization.id,
        apiKey: `tr_prod_${projectSlug}`,
        pkApiKey: `pk_prod_${projectSlug}`,
        shortcode: `prod${suffix()}`,
      },
    });
    const worker = await prisma.backgroundWorker.create({
      data: {
        friendlyId: `worker_${projectSlug}`,
        contentHash: `hash_${projectSlug}`,
        projectId: project.id,
        runtimeEnvironmentId: environment.id,
        version: `2026.09.01.1`,
        metadata: {},
        engine: "V2",
      },
    });
    await prisma.workerDeployment.create({
      data: {
        friendlyId: `deployment_${projectSlug}`,
        shortCode: `short_${name}`,
        contentHash: `hash_${projectSlug}`,
        imageReference: `registry.example/${projectSlug}:1`,
        projectId: project.id,
        environmentId: environment.id,
        workerId: worker.id,
        version: worker.version,
        status: "DEPLOYED",
        commitSHA: `sha_${name}`,
        git: { commitMessage: `commit in ${name}`, dirty: false },
      },
    });
    const run = await prisma.taskRun.create({
      data: {
        engine: "V2",
        status: "COMPLETED_SUCCESSFULLY",
        friendlyId: `run_${projectSlug}`,
        runtimeEnvironmentId: environment.id,
        environmentType: "PRODUCTION",
        organizationId: organization.id,
        projectId: project.id,
        taskIdentifier: "my-task",
        payload: "{}",
        payloadType: "application/json",
        traceContext: {},
        traceId: `trace_${projectSlug}`,
        spanId: `span_${projectSlug}`,
        queue: "task/my-task",
        isTest: false,
        taskEventStore: "taskEvent",
        depth: 0,
        lockedToVersionId: worker.id,
      },
    });

    return { project, environment, run, shortCode: `short_${name}` };
  }

  return {
    member,
    organization,
    current: await projectWithRun("current"),
    sibling: await projectWithRun("sibling"),
  };
}

async function callLoader(opts: {
  projectRef: string;
  runId: string;
  userId: string;
  organizationId?: string;
  environmentId?: string;
}): Promise<{ status: number; body: any }> {
  const token = await signUserActorToken(SESSION_SECRET, {
    userId: opts.userId,
    client: "dashboard-agent",
    ...(opts.organizationId ? { organizationId: opts.organizationId } : {}),
    ...(opts.environmentId ? { environmentId: opts.environmentId } : {}),
    cap: ["read:deployments"],
  });

  try {
    const response = await loader({
      request: new Request(
        `https://api.trigger.dev/api/v1/projects/${opts.projectRef}/prod/runs/${opts.runId}/commit`,
        { headers: { Authorization: `Bearer ${token}` } }
      ),
      params: { projectRef: opts.projectRef, env: "prod", runId: opts.runId },
      context: {},
    } as any);
    return { status: response.status, body: await response.json() };
  } catch (thrown) {
    if (thrown instanceof Response) return { status: thrown.status, body: await thrown.json() };
    throw thrown;
  }
}

postgresTest(
  "org-wide user-actor token resolves a sibling project's run commit",
  async ({ prisma }) => {
    ctx.prisma = prisma;
    const orgA = await seedOrg(prisma);
    const orgB = await seedOrg(prisma);

    // The shape the dashboard agent mints: the turn's environment plus its organization.
    const minted = {
      userId: orgA.member.id,
      organizationId: orgA.organization.id,
      environmentId: orgA.current.environment.id,
    };

    // A sibling project of the same org — the live repro. Full commit payload, not a 403.
    const sibling = await callLoader({
      ...minted,
      projectRef: orgA.sibling.project.externalRef,
      runId: orgA.sibling.run.friendlyId,
    });
    expect(sibling.status).toBe(200);
    expect(sibling.body.sha).toBe("sha_sibling");
    expect(sibling.body.shortCode).toBe("short_sibling");
    expect(sibling.body.git.commitMessage).toBe("commit in sibling");

    // Its own environment still works.
    const own = await callLoader({
      ...minted,
      projectRef: orgA.current.project.externalRef,
      runId: orgA.current.run.friendlyId,
    });
    expect(own.status).toBe(200);
    expect(own.body.sha).toBe("sha_current");

    // Another organization, reached by a user who belongs to both — so the refusal is the org
    // boundary itself, not a missing membership.
    const crossMember = await prisma.user.create({
      data: { email: `cross-${suffix()}@example.com`, authenticationMethod: "MAGIC_LINK" },
    });
    for (const organizationId of [orgA.organization.id, orgB.organization.id]) {
      await prisma.orgMember.create({
        data: { organizationId, userId: crossMember.id, role: "ADMIN" },
      });
    }

    const foreign = await callLoader({
      userId: crossMember.id,
      organizationId: orgA.organization.id,
      environmentId: orgA.current.environment.id,
      projectRef: orgB.current.project.externalRef,
      runId: orgB.current.run.friendlyId,
    });
    expect(foreign.status).toBe(403);
    expect(foreign.body.code).toBe("forbidden_environment");

    // Same claim, its own org: the very same user is admitted, so 403 above is the boundary.
    const crossOwn = await callLoader({
      userId: crossMember.id,
      organizationId: orgA.organization.id,
      environmentId: orgA.current.environment.id,
      projectRef: orgA.sibling.project.externalRef,
      runId: orgA.sibling.run.friendlyId,
    });
    expect(crossOwn.status).toBe(200);

    // An org claim for an org the user isn't a member of.
    const outsider = await callLoader({
      userId: orgB.member.id,
      organizationId: orgA.organization.id,
      environmentId: orgA.current.environment.id,
      projectRef: orgA.sibling.project.externalRef,
      runId: orgA.sibling.run.friendlyId,
    });
    expect(outsider.status).toBe(404);

    // An environment claim with no org claim is unchanged: its own environment only.
    const envOnly = {
      userId: orgA.member.id,
      environmentId: orgA.current.environment.id,
    };
    const scoped = await callLoader({
      ...envOnly,
      projectRef: orgA.current.project.externalRef,
      runId: orgA.current.run.friendlyId,
    });
    expect(scoped.status).toBe(200);

    const scopedSibling = await callLoader({
      ...envOnly,
      projectRef: orgA.sibling.project.externalRef,
      runId: orgA.sibling.run.friendlyId,
    });
    expect(scopedSibling.status).toBe(403);
    expect(scopedSibling.body.code).toBe("forbidden_environment");

    // The control: without the opt-in, the same org-claim token is refused a sibling
    // environment, so the flag stays the only way in.
    const authenticationResult = {
      type: "personalAccessToken" as const,
      result: { userId: orgA.member.id },
      userActor: { ...minted, client: "dashboard-agent" },
    };

    try {
      await authenticatedEnvironmentForAuthentication(
        authenticationResult,
        orgA.sibling.project.externalRef,
        "prod"
      );
      expect.unreachable("a sibling environment must be refused without the opt-in");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response);
      expect((thrown as Response).status).toBe(403);
    }
  }
);
