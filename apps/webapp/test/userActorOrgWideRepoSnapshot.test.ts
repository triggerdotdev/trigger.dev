/**
 * The repo-snapshot route feeds the agent's code tools, so an org-wide user-actor token has to
 * reach a sibling project and its preview branches. Another member's dev env, another
 * organization and an environment-only claim all stay refused.
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
// The real resolver talks to the GitHub app. Echo back the project the route resolved instead,
// so the assertions can name it.
vi.mock("~/services/dashboardAgent.server", () => ({
  resolveDashboardAgentRepoSnapshot: async (projectId: string) => ({
    owner: "acme",
    repo: projectId,
    sha: "a".repeat(40),
    tarballUrl: `https://codeload.example/${projectId}`,
  }),
  resolveRunCommit: async () => null,
}));

const { loader } = await import("~/routes/api.v1.projects.$projectRef.$env.repo.snapshot");

function suffix() {
  return Math.random().toString(36).slice(2, 10);
}

/** An org with two projects, each with prod, a preview branch, and a second member's dev env. */
async function seedOrg(prisma: PrismaClient) {
  const slug = `reposnapshot_${suffix()}`;
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

  async function projectWithEnvironments(name: string) {
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
    await environmentFor({
      slug: `preview-feat-${name}`,
      type: "PREVIEW",
      branchName: `feat/${name}`,
      parentEnvironmentId: previewParent.id,
    });

    return { project, prod };
  }

  return {
    member,
    organization,
    current: await projectWithEnvironments("current"),
    sibling: await projectWithEnvironments("sibling"),
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
    cap: ["read:apiKeys"],
  });

  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (opts.branch) headers["x-trigger-branch"] = opts.branch;

  try {
    const response = await loader({
      request: new Request(
        `https://api.trigger.dev/api/v1/projects/${opts.projectRef}/${opts.env}/repo/snapshot`,
        { headers }
      ),
      params: { projectRef: opts.projectRef, env: opts.env },
      context: {},
    } as any);
    return { status: response.status, body: await response.json() };
  } catch (thrown) {
    if (thrown instanceof Response) return { status: thrown.status, body: await thrown.json() };
    throw thrown;
  }
}

postgresTest(
  "org-wide user-actor token reads a sibling project's repo snapshot",
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

    // A sibling project of the same org — the live repro. Its own snapshot, not a 403.
    const sibling = await callLoader({
      ...minted,
      projectRef: orgA.sibling.project.externalRef,
      env: "prod",
    });
    expect(sibling.status).toBe(200);
    expect(sibling.body.repo).toBe(orgA.sibling.project.id);

    // Its own environment still works.
    const own = await callLoader({
      ...minted,
      projectRef: orgA.current.project.externalRef,
      env: "prod",
    });
    expect(own.status).toBe(200);
    expect(own.body.repo).toBe(orgA.current.project.id);

    // A preview branch of the sibling project, addressed the way the agent addresses one.
    const branch = await callLoader({
      ...minted,
      projectRef: orgA.sibling.project.externalRef,
      env: "preview",
      branch: "feat/sibling",
    });
    expect(branch.status).toBe(200);
    expect(branch.body.repo).toBe(orgA.sibling.project.id);

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
