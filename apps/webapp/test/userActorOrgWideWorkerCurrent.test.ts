/**
 * The current-worker route is how the agent lists a project's tasks, so an org-wide user-actor
 * token has to reach a sibling project and its preview branches. Another member's dev env,
 * another organization and an environment-only claim all stay refused.
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
vi.mock("~/env.server", () => ({
  env: { SESSION_SECRET: "test-session-secret", APP_ORIGIN: "https://cloud.trigger.dev" },
}));
vi.mock("~/services/logger.server", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const { loader } = await import("~/routes/api.v1.projects.$projectRef.$env.workers.$tagName");

function suffix() {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * An org with two projects. Each has prod plus a preview branch, both carrying a promoted
 * deployment with one task named after the project, and a dev env owned by a second member.
 */
async function seedOrg(prisma: PrismaClient) {
  const slug = `workercurrent_${suffix()}`;
  const member = await prisma.user.create({
    data: { email: `${slug}-member@example.com`, authenticationMethod: "MAGIC_LINK" },
  });
  const other = await prisma.user.create({
    data: { email: `${slug}-other@example.com`, authenticationMethod: "MAGIC_LINK" },
  });
  const organization = await prisma.organization.create({ data: { title: slug, slug } });
  await prisma.orgMember.create({
    data: { organizationId: organization.id, userId: member.id, role: "ADMIN" },
  });
  const otherMembership = await prisma.orgMember.create({
    data: { organizationId: organization.id, userId: other.id, role: "ADMIN" },
  });

  async function projectWithWorkers(name: string) {
    const projectSlug = `${slug}_${name}`;
    const project = await prisma.project.create({
      data: {
        name: projectSlug,
        slug: projectSlug,
        organizationId: organization.id,
        externalRef: `proj_${projectSlug}`,
      },
    });

    const environmentFor = (data: {
      slug: string;
      type: "PRODUCTION" | "DEVELOPMENT" | "PREVIEW";
      branchName?: string;
      parentEnvironmentId?: string;
      orgMemberId?: string;
    }) =>
      prisma.runtimeEnvironment.create({
        data: {
          slug: data.slug,
          type: data.type,
          branchName: data.branchName,
          parentEnvironmentId: data.parentEnvironmentId,
          orgMemberId: data.orgMemberId,
          projectId: project.id,
          organizationId: organization.id,
          apiKey: `tr_${data.slug}_${projectSlug}`,
          pkApiKey: `pk_${data.slug}_${projectSlug}`,
          shortcode: `${suffix()}`,
        },
      });

    const prod = await environmentFor({ slug: "prod", type: "PRODUCTION" });
    // Dev rows are per-member, so this one belongs to somebody else in the same org.
    await environmentFor({
      slug: "dev",
      type: "DEVELOPMENT",
      orgMemberId: otherMembership.id,
    });
    const previewParent = await environmentFor({ slug: "preview", type: "PREVIEW" });
    const previewBranch = await environmentFor({
      slug: `preview-feat-${name}`,
      type: "PREVIEW",
      branchName: `feat/${name}`,
      parentEnvironmentId: previewParent.id,
    });

    async function promoteWorker(environment: { id: string }, label: string, taskSlug: string) {
      const version = `2026.09.02.1`;
      const worker = await prisma.backgroundWorker.create({
        data: {
          friendlyId: `worker_${label}_${projectSlug}`,
          contentHash: `hash_${label}_${projectSlug}`,
          projectId: project.id,
          runtimeEnvironmentId: environment.id,
          version,
          metadata: {},
          engine: "V2",
        },
      });
      await prisma.backgroundWorkerTask.create({
        data: {
          friendlyId: `task_${label}_${projectSlug}`,
          slug: taskSlug,
          filePath: `src/trigger/${taskSlug}.ts`,
          exportName: taskSlug,
          workerId: worker.id,
          runtimeEnvironmentId: environment.id,
          projectId: project.id,
        },
      });
      const deployment = await prisma.workerDeployment.create({
        data: {
          friendlyId: `deployment_${label}_${projectSlug}`,
          shortCode: `short_${label}_${suffix()}`,
          contentHash: worker.contentHash,
          imageReference: `registry.example/${projectSlug}:1`,
          projectId: project.id,
          environmentId: environment.id,
          workerId: worker.id,
          version,
          status: "DEPLOYED",
        },
      });
      await prisma.workerDeploymentPromotion.create({
        data: { label: "current", environmentId: environment.id, deploymentId: deployment.id },
      });

      return worker;
    }

    await promoteWorker(prod, "prod", `${name}-prod-task`);
    await promoteWorker(previewBranch, "preview", `${name}-preview-task`);

    return { project, prod };
  }

  return {
    member,
    organization,
    current: await projectWithWorkers("current"),
    sibling: await projectWithWorkers("sibling"),
  };
}

async function callLoader(opts: {
  projectRef: string;
  env: string;
  branch?: string;
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

  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (opts.branch) headers["x-trigger-branch"] = opts.branch;

  try {
    const response = await loader({
      request: new Request(
        `https://api.trigger.dev/api/v1/projects/${opts.projectRef}/${opts.env}/workers/current`,
        { headers }
      ),
      params: { projectRef: opts.projectRef, env: opts.env, tagName: "current" },
      context: {},
    } as any);
    return { status: response.status, body: await response.json() };
  } catch (thrown) {
    if (thrown instanceof Response) return { status: thrown.status, body: await thrown.json() };
    throw thrown;
  }
}

postgresTest(
  "org-wide user-actor token reads a sibling project's current worker",
  async ({ prisma }) => {
    ctx.prisma = prisma;
    const orgA = await seedOrg(prisma);
    const orgB = await seedOrg(prisma);

    // The shape the dashboard agent mints: the turn's environment plus its organization.
    const minted = {
      userId: orgA.member.id,
      organizationId: orgA.organization.id,
      environmentId: orgA.current.prod.id,
    };

    // A sibling project of the same org — the live repro. Its own tasks, not a 403.
    const sibling = await callLoader({
      ...minted,
      projectRef: orgA.sibling.project.externalRef,
      env: "prod",
    });
    expect(sibling.status).toBe(200);
    expect(sibling.body.worker.tasks.map((task: any) => task.slug)).toEqual(["sibling-prod-task"]);

    // Its own environment still works.
    const own = await callLoader({
      ...minted,
      projectRef: orgA.current.project.externalRef,
      env: "prod",
    });
    expect(own.status).toBe(200);
    expect(own.body.worker.tasks.map((task: any) => task.slug)).toEqual(["current-prod-task"]);

    // A preview branch of the sibling project, addressed the way the agent addresses one.
    const branch = await callLoader({
      ...minted,
      projectRef: orgA.sibling.project.externalRef,
      env: "preview",
      branch: "feat/sibling",
    });
    expect(branch.status).toBe(200);
    expect(branch.body.worker.tasks.map((task: any) => task.slug)).toEqual([
      "sibling-preview-task",
    ]);

    // Another member's dev environment: org membership doesn't hand over a personal dev env.
    const otherDev = await callLoader({
      ...minted,
      projectRef: orgA.sibling.project.externalRef,
      env: "dev",
    });
    expect(otherDev.status).toBe(404);

    // A project in another organization, reached by a user who belongs to both — so the refusal
    // is the org boundary itself, not a missing membership.
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
      environmentId: orgA.current.prod.id,
      projectRef: orgB.current.project.externalRef,
      env: "prod",
    });
    expect(foreign.status).toBe(403);
    expect(foreign.body.code).toBe("forbidden_environment");

    // Same claim, its own org: the very same user is admitted, so the 403 above is the boundary.
    const crossOwn = await callLoader({
      userId: crossMember.id,
      organizationId: orgA.organization.id,
      environmentId: orgA.current.prod.id,
      projectRef: orgA.sibling.project.externalRef,
      env: "prod",
    });
    expect(crossOwn.status).toBe(200);

    // An environment claim with no org claim is unchanged: its own environment only.
    const envOnly = { userId: orgA.member.id, environmentId: orgA.current.prod.id };
    const scoped = await callLoader({
      ...envOnly,
      projectRef: orgA.current.project.externalRef,
      env: "prod",
    });
    expect(scoped.status).toBe(200);

    const scopedSibling = await callLoader({
      ...envOnly,
      projectRef: orgA.sibling.project.externalRef,
      env: "prod",
    });
    expect(scopedSibling.status).toBe(403);
    expect(scopedSibling.body.code).toBe("forbidden_environment");
  }
);
