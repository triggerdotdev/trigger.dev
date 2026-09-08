import type { PrismaClient } from "@trigger.dev/database";
import { RunId } from "@trigger.dev/core/v3/isomorphic";

/** Shared seeding for the dashboard agent's org-scoped services (locate, URI resolution). */

export function agentSlug() {
  return `s${Math.random().toString(36).slice(2, 10)}`;
}

export async function createRun(prisma: PrismaClient, projectId: string, environmentId: string) {
  const friendlyId = RunId.generate().friendlyId;
  await prisma.taskRun.create({
    data: {
      friendlyId,
      taskIdentifier: "my-task",
      payload: "{}",
      traceId: "trace",
      spanId: "span",
      queue: "main",
      projectId,
      runtimeEnvironmentId: environmentId,
    },
  });
  return friendlyId;
}

export async function createQueue(
  prisma: PrismaClient,
  projectId: string,
  environmentId: string,
  name: string
) {
  await prisma.taskQueue.create({
    data: {
      friendlyId: `queue_${agentSlug()}`,
      name,
      projectId,
      runtimeEnvironmentId: environmentId,
    },
  });
}

function createProject(prisma: PrismaClient, organizationId: string, deleted = false) {
  const id = agentSlug();
  return prisma.project.create({
    data: {
      name: id,
      slug: id,
      externalRef: `proj_${id}`,
      organizationId,
      ...(deleted ? { deletedAt: new Date() } : {}),
    },
  });
}

type EnvOpts = {
  slug: string;
  type: "PRODUCTION" | "STAGING" | "DEVELOPMENT" | "PREVIEW";
  orgMemberId?: string;
  branchName?: string;
  parentEnvironmentId?: string;
  archivedAt?: Date;
};

/** Curried per-project so callers only ever name what varies between one project's environments. */
function envFactory(prisma: PrismaClient, projectId: string, organizationId: string) {
  return (opts: EnvOpts) => {
    const id = agentSlug();
    return prisma.runtimeEnvironment.create({
      data: {
        slug: opts.slug,
        type: opts.type,
        projectId,
        organizationId,
        apiKey: `tr_${id}`,
        pkApiKey: `pk_${id}`,
        shortcode: id,
        ...(opts.orgMemberId ? { orgMemberId: opts.orgMemberId } : {}),
        ...(opts.branchName ? { branchName: opts.branchName } : {}),
        ...(opts.parentEnvironmentId ? { parentEnvironmentId: opts.parentEnvironmentId } : {}),
        ...(opts.archivedAt ? { archivedAt: opts.archivedAt } : {}),
      },
    });
  };
}

/**
 * The canonical world every case draws from: org A holds P1 (the actor's own dev + prod +
 * staging) and P2 (another member's dev + prod + a preview branch + an archived environment),
 * plus a soft-deleted project. Org B proves the organization boundary, org C the soft-deleted
 * organization, and the stranger has no membership anywhere. Each container test gets a fresh
 * cloned database, so re-seeding this per test is cheap and never leaks state across cases.
 */
export async function seedAgentWorld(prisma: PrismaClient) {
  const createUser = () =>
    prisma.user.create({
      data: { email: `${agentSlug()}@example.com`, authenticationMethod: "MAGIC_LINK" },
    });
  const actorUser = await createUser();
  const otherUser = await createUser();
  const strangerUser = await createUser();

  const orgA = await prisma.organization.create({
    data: {
      title: agentSlug(),
      slug: agentSlug(),
      members: {
        create: [
          { userId: actorUser.id, role: "ADMIN" },
          { userId: otherUser.id, role: "MEMBER" },
        ],
      },
    },
  });
  const actorMember = await prisma.orgMember.findFirstOrThrow({
    where: { organizationId: orgA.id, userId: actorUser.id },
  });
  const otherMember = await prisma.orgMember.findFirstOrThrow({
    where: { organizationId: orgA.id, userId: otherUser.id },
  });

  const p1 = await createProject(prisma, orgA.id);
  const p1Env = envFactory(prisma, p1.id, orgA.id);
  const p1Dev = await p1Env({ slug: "dev", type: "DEVELOPMENT", orgMemberId: actorMember.id });
  const p1Prod = await p1Env({ slug: "prod", type: "PRODUCTION" });
  const p1Staging = await p1Env({ slug: "stg", type: "STAGING" });

  const p2 = await createProject(prisma, orgA.id);
  const p2Env = envFactory(prisma, p2.id, orgA.id);
  const p2Dev = await p2Env({ slug: "dev", type: "DEVELOPMENT", orgMemberId: otherMember.id });
  const p2Prod = await p2Env({ slug: "prod", type: "PRODUCTION" });
  const p2Preview = await p2Env({ slug: "preview", type: "PREVIEW" });
  // A branch env's own slug is the composite `<parent>-<branch>` shape (`upsertBranch.server.ts`)
  // — the canonical name lives on the parent.
  const p2Branch = await p2Env({
    slug: `${p2Preview.slug}-feat-a`,
    type: "PREVIEW",
    branchName: "feat/a",
    parentEnvironmentId: p2Preview.id,
  });
  const p2Archived = await p2Env({
    slug: "archived",
    type: "PRODUCTION",
    archivedAt: new Date(),
  });

  const deletedProject = await createProject(prisma, orgA.id, true);
  const deletedProd = await envFactory(
    prisma,
    deletedProject.id,
    orgA.id
  )({ slug: "prod", type: "PRODUCTION" });

  const orgB = await prisma.organization.create({
    data: { title: agentSlug(), slug: agentSlug() },
  });
  const p3 = await createProject(prisma, orgB.id);
  const p3Prod = await envFactory(prisma, p3.id, orgB.id)({ slug: "prod", type: "PRODUCTION" });

  const orgC = await prisma.organization.create({
    data: {
      title: agentSlug(),
      slug: agentSlug(),
      deletedAt: new Date(),
      members: { create: [{ userId: actorUser.id, role: "ADMIN" }] },
    },
  });
  const p4 = await createProject(prisma, orgC.id);
  const p4Prod = await envFactory(prisma, p4.id, orgC.id)({ slug: "prod", type: "PRODUCTION" });

  return {
    actorUser,
    otherUser,
    strangerUser,
    orgA,
    orgB,
    orgC,
    p1,
    p1Dev,
    p1Prod,
    p1Staging,
    p2,
    p2Dev,
    p2Prod,
    p2Preview,
    p2Branch,
    p2Archived,
    deletedProject,
    deletedProd,
    p3,
    p3Prod,
    p4,
    p4Prod,
    actor: { userId: actorUser.id, organizationId: orgA.id },
    stranger: { userId: strangerUser.id, organizationId: orgA.id },
    deletedOrgActor: { userId: actorUser.id, organizationId: orgC.id },
  };
}

export type AgentWorld = Awaited<ReturnType<typeof seedAgentWorld>>;
