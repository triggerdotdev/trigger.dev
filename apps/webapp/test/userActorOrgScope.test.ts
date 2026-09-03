/**
 * A user-actor token minted for one environment, or for a whole organization, must reach exactly
 * what its claim says and nothing else — membership is the tenant floor, the claim only narrows
 * inside it. One shared org (two projects, every environment family, a second member's own dev
 * env) and a second org drive every UAT-accepting route through the real loader against a real
 * database; only external I/O (repo archives, tracing) is stubbed.
 */

import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { buildJwtAbility, signUserActorToken, verifyUserActorToken } from "@trigger.dev/rbac";
import { validateJWT } from "@trigger.dev/core/v3/jwt";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as DashboardAgentServer from "~/services/dashboardAgent.server";
import type * as PersonalAccessTokenServer from "~/services/personalAccessToken.server";
import type * as RbacServer from "~/services/rbac.server";

const SESSION_SECRET = "test-session-secret-for-user-actor-org-scope";

const ctx = vi.hoisted(() => ({ prisma: undefined as unknown as PrismaClient }));
const mocks = vi.hoisted(() => {
  const assertSourcePatActive = vi.fn<(...args: any[]) => Promise<boolean>>();
  assertSourcePatActive.mockResolvedValue(true);
  const resolveDashboardAgentRepoSnapshot = vi.fn(async (projectId: string) => ({
    owner: "acme",
    repo: projectId,
    sha: "a".repeat(40),
    tarballUrl: `https://codeload.example/${projectId}`,
  }));
  return { assertSourcePatActive, resolveDashboardAgentRepoSnapshot };
});

vi.mock("~/db.server", () => {
  const proxy = new Proxy(
    {},
    { get: (_target, prop) => (ctx.prisma as unknown as Record<string, unknown>)[prop as string] }
  );
  return { prisma: proxy, $replica: proxy, sqlDatabaseSchema: undefined };
});
vi.mock("~/env.server", () => ({
  env: {
    SESSION_SECRET,
    APP_ORIGIN: "https://example.com",
    ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
    RBAC_FORCE_FALLBACK: true,
  },
}));
vi.mock("~/services/logger.server", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock("~/services/authTelemetry.server", () => ({
  authenticateAuthorizeBearerWithTelemetry: vi.fn(),
  authenticateBearerWithTelemetry: vi.fn(),
  observeLegacyBearerAuthentication: vi.fn(),
}));
vi.mock("~/services/tenantContext.server", () => ({
  tenantContext: { enrich: vi.fn() },
  tenantContextFromAuthEnvironment: vi.fn(),
}));
vi.mock("~/v3/services/worker/workerGroupTokenService.server", () => ({
  WorkerGroupTokenService: class {},
}));
vi.mock("~/v3/services/common.server", () => ({ ServiceValidationError: class extends Error {} }));
vi.mock("@internal/run-engine", () => ({ EngineServiceValidationError: class extends Error {} }));
// The run store shards across databases; the commit lookup only needs the run's locked version.
vi.mock("~/v3/runStore.server", () => ({
  runStore: {
    findRunOnPrimary: async (where: Record<string, unknown>, opts: { select: any }) =>
      ctx.prisma.taskRun.findFirst({ where: where as any, select: opts.select }),
  },
}));
// The real resolver talks to the GitHub app. Echo back the project the route resolved instead.
vi.mock("~/services/dashboardAgent.server", async (importOriginal) => {
  const actual = await importOriginal<typeof DashboardAgentServer>();
  return {
    ...actual,
    resolveDashboardAgentRepoSnapshot: mocks.resolveDashboardAgentRepoSnapshot,
  };
});
vi.mock("~/services/personalAccessToken.server", async (importOriginal) => {
  const actual = await importOriginal<typeof PersonalAccessTokenServer>();
  return {
    ...actual,
    assertSourcePatActive: mocks.assertSourcePatActive,
    // A `tr_pat_` bearer resolves to whichever user the case names, driving the non-UAT branch.
    isPersonalAccessToken: (token: string) => token.startsWith("tr_pat_"),
    authenticateApiRequestWithPersonalAccessToken: async () => ({ userId: patBearerUserId }),
  };
});

let patBearerUserId = "";
// The OSS fallback's ability is otherwise purely cap-driven (UAT) or permissive (PAT) — there's
// no real path to a role that fails a specific `can()` check. Set this to force one, for the one
// case that needs it; `undefined` (the default) leaves the real ability untouched.
let forcedAbilityCan: ((action: string, resource: unknown) => boolean) | undefined;

// The real fallback's `authenticatePat` looks up a real PAT row by hash, which the synthetic
// `tr_pat_e2e_token` bearer used below has none of. Only that lookup is stubbed; every UAT check
// (`authenticateUserActor`) stays real, aside from the opt-in ability override above.
vi.mock("~/services/rbac.server", async (importOriginal) => {
  const actual = await importOriginal<typeof RbacServer>();
  // Patched in place (not spread): the plugin's methods are bound to its own instance.
  const realAuthenticateUserActor = actual.rbac.authenticateUserActor.bind(actual.rbac);
  actual.rbac.authenticateUserActor = async (
    ...args: Parameters<typeof realAuthenticateUserActor>
  ) => {
    const result = await realAuthenticateUserActor(...args);
    if (result.ok && forcedAbilityCan) {
      return { ...result, ability: { ...result.ability, can: forcedAbilityCan } };
    }
    return result;
  };
  actual.rbac.authenticatePat = async () => ({
    ok: true as const,
    userId: patBearerUserId,
    tokenId: "pat_e2e",
    lastAccessedAt: null,
    ability: buildJwtAbility(["read:all"]),
  });
  return actual;
});

const { loader: commitLoader } =
  await import("~/routes/api.v1.projects.$projectRef.$env.runs.$runId.commit");
const { loader: snapshotLoader } =
  await import("~/routes/api.v1.projects.$projectRef.$env.repo.snapshot");
const { loader: workerLoader } =
  await import("~/routes/api.v1.projects.$projectRef.$env.workers.$tagName");
const { action: jwtAction } = await import("~/routes/api.v1.projects.$projectRef.$env.jwt");
const { loader: environmentsLoader } =
  await import("~/routes/api.v1.projects.$projectRef.environments");
const { loader: projectsLoader } = await import("~/routes/api.v1.projects");
const { authenticatedEnvironmentForAuthentication } = await import("~/services/apiAuth.server");
const {
  assertUserActorEnvironment,
  assertUserActorEnvironmentAccess,
  assertUserActorScope,
  resolveUserActorEnvironmentScope,
} = await import("~/services/userActorEnvironment.server");
const { resolveAgentTokenScope } = await import("~/services/dashboardAgentTokenScope");
const { DASHBOARD_AGENT_UAT_CAP, mintDashboardAgentUserActorToken } =
  await import("~/services/dashboardAgent.server");

function suffix() {
  return Math.random().toString(36).slice(2, 10);
}

/** The full cap the dashboard agent actually mints; enough for every route under test. */
const FULL_CAP = ["read:apiKeys", "read:runs", "read:deployments", "read:environments"];

/**
 * One org with two projects ("current", the turn's project, and "sibling"), each carrying every
 * environment family an agent token can be scoped to: prod, staging, a member-owned dev, a
 * preview parent + branch. A second member owns "sibling"'s dev (org membership never hands over
 * someone else's dev env). A second org holds one project, for the cross-org boundary. A
 * `crossMember` belongs to both orgs, so a cross-org refusal proves the org boundary itself
 * rather than a missing membership.
 */
async function seedWorld(prisma: PrismaClient) {
  const slug = `uatscope_${suffix()}`;
  const member = await prisma.user.create({
    data: { email: `${slug}-member@example.com`, authenticationMethod: "MAGIC_LINK" },
  });
  const other = await prisma.user.create({
    data: { email: `${slug}-other@example.com`, authenticationMethod: "MAGIC_LINK" },
  });
  const crossMember = await prisma.user.create({
    data: { email: `${slug}-cross@example.com`, authenticationMethod: "MAGIC_LINK" },
  });
  const stranger = await prisma.user.create({
    data: { email: `${slug}-stranger@example.com`, authenticationMethod: "MAGIC_LINK" },
  });

  const orgA = await prisma.organization.create({
    data: { title: `${slug}-a`, slug: `${slug}-a` },
  });
  const orgB = await prisma.organization.create({
    data: { title: `${slug}-b`, slug: `${slug}-b` },
  });

  const memberOfA = await prisma.orgMember.create({
    data: { organizationId: orgA.id, userId: member.id, role: "ADMIN" },
  });
  const otherOfA = await prisma.orgMember.create({
    data: { organizationId: orgA.id, userId: other.id, role: "ADMIN" },
  });
  await prisma.orgMember.create({
    data: { organizationId: orgA.id, userId: crossMember.id, role: "ADMIN" },
  });
  await prisma.orgMember.create({
    data: { organizationId: orgB.id, userId: crossMember.id, role: "ADMIN" },
  });

  async function projectWithEnvironments(name: string, extraDevOwnerMembershipId?: string) {
    const projectSlug = `${slug}_${name}`;
    const project = await prisma.project.create({
      data: {
        name: projectSlug,
        slug: projectSlug,
        version: "V3",
        organizationId: orgA.id,
        externalRef: `proj_${projectSlug}`,
      },
    });
    const envFor = (data: {
      slug: string;
      type: "PRODUCTION" | "STAGING" | "DEVELOPMENT" | "PREVIEW";
      branchName?: string;
      parentEnvironmentId?: string;
      orgMemberId?: string;
    }) =>
      prisma.runtimeEnvironment.create({
        data: {
          ...data,
          projectId: project.id,
          organizationId: orgA.id,
          // Two dev rows can share a slug (unique key is projectId+slug+orgMemberId), so the key
          // needs its own uniqueness source too.
          apiKey: `tr_${data.slug}_${projectSlug}_${suffix()}`,
          pkApiKey: `pk_${data.slug}_${projectSlug}_${suffix()}`,
          shortcode: `${data.slug}${suffix()}`,
        },
      });

    const prod = await envFor({ slug: "prod", type: "PRODUCTION" });
    const staging = await envFor({ slug: "stg", type: "STAGING" });
    // The caller's own dev, on every project — org membership never substitutes for it.
    const dev = await envFor({ slug: "dev", type: "DEVELOPMENT", orgMemberId: memberOfA.id });
    const devBranch = await envFor({
      slug: `dev-feat-${name}`,
      type: "DEVELOPMENT",
      branchName: `feat/${name}`,
      parentEnvironmentId: dev.id,
      orgMemberId: memberOfA.id,
    });
    // A second member's own dev, same slug — the unique key is (project, slug, orgMember), so
    // both rows coexist. Org membership doesn't hand this one over to the caller.
    const otherDev = extraDevOwnerMembershipId
      ? await envFor({ slug: "dev", type: "DEVELOPMENT", orgMemberId: extraDevOwnerMembershipId })
      : undefined;
    const previewParent = await envFor({ slug: "preview", type: "PREVIEW" });
    const previewBranch = await envFor({
      slug: `preview-feat-${name}`,
      type: "PREVIEW",
      branchName: `feat/${name}`,
      parentEnvironmentId: previewParent.id,
    });

    async function promote(environment: { id: string }, taskSlug: string) {
      const version = "2026.09.02.1";
      const worker = await prisma.backgroundWorker.create({
        data: {
          friendlyId: `worker_${taskSlug}`,
          contentHash: `hash_${taskSlug}`,
          projectId: project.id,
          runtimeEnvironmentId: environment.id,
          version,
          metadata: {},
          engine: "V2",
        },
      });
      await prisma.backgroundWorkerTask.create({
        data: {
          friendlyId: `task_${taskSlug}`,
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
          friendlyId: `deployment_${taskSlug}`,
          shortCode: `short_${taskSlug}`,
          contentHash: worker.contentHash,
          imageReference: `registry.example/${projectSlug}:1`,
          projectId: project.id,
          environmentId: environment.id,
          workerId: worker.id,
          version,
          status: "DEPLOYED",
          commitSHA: `sha_${name}`,
          git: { commitMessage: `commit in ${name}`, dirty: false },
        },
      });
      await prisma.workerDeploymentPromotion.create({
        data: { label: "current", environmentId: environment.id, deploymentId: deployment.id },
      });
      return { worker, deployment };
    }

    const prodPromotion = await promote(prod, `${name}-prod-task`);
    const stagingPromotion = await promote(staging, `${name}-staging-task`);
    await promote(previewBranch, `${name}-preview-task`);
    await promote(devBranch, `${name}-dev-branch-task`);

    async function runOn(
      environment: { id: string },
      envType: string,
      promo: typeof prodPromotion
    ) {
      return prisma.taskRun.create({
        data: {
          engine: "V2",
          status: "COMPLETED_SUCCESSFULLY",
          friendlyId: `run_${envType}_${projectSlug}`,
          runtimeEnvironmentId: environment.id,
          environmentType: envType as any,
          organizationId: orgA.id,
          projectId: project.id,
          taskIdentifier: `${name}-${envType}-task`,
          payload: "{}",
          payloadType: "application/json",
          traceContext: {},
          traceId: `trace_${envType}_${projectSlug}`,
          spanId: `span_${envType}_${projectSlug}`,
          queue: `task/${name}-${envType}-task`,
          isTest: false,
          taskEventStore: "taskEvent",
          depth: 0,
          lockedToVersionId: promo.worker.id,
        },
      });
    }

    const run = await runOn(prod, "PRODUCTION", prodPromotion);
    const stagingRun = await runOn(staging, "STAGING", stagingPromotion);

    return {
      project,
      prod,
      staging,
      dev,
      devBranch,
      otherDev,
      previewParent,
      previewBranch,
      run,
      stagingRun,
    };
  }

  const current = await projectWithEnvironments("current");
  const sibling = await projectWithEnvironments("sibling", otherOfA.id);

  const bProject = await prisma.project.create({
    data: {
      name: `${slug}_b`,
      slug: `${slug}_b`,
      version: "V3",
      organizationId: orgB.id,
      externalRef: `proj_${slug}_b`,
    },
  });
  const bProd = await prisma.runtimeEnvironment.create({
    data: {
      slug: "prod",
      type: "PRODUCTION",
      projectId: bProject.id,
      organizationId: orgB.id,
      apiKey: `tr_prod_${slug}_b`,
      pkApiKey: `pk_prod_${slug}_b`,
      shortcode: `bprod${suffix()}`,
    },
  });

  return { orgA, orgB, member, other, crossMember, stranger, current, sibling, bProject, bProd };
}

async function mintUat(opts: {
  userId: string;
  environmentId?: string;
  organizationId?: string;
  client?: string;
  cap?: string[];
}) {
  return signUserActorToken(SESSION_SECRET, {
    userId: opts.userId,
    client: opts.client ?? "dashboard-agent",
    ...(opts.environmentId ? { environmentId: opts.environmentId } : {}),
    ...(opts.organizationId ? { organizationId: opts.organizationId } : {}),
    cap: opts.cap ?? FULL_CAP,
  });
}

/** A route throws its json Response for the failures it doesn't build itself. */
async function respond(call: () => Promise<Response>): Promise<{ status: number; body: any }> {
  try {
    const response = await call();
    return { status: response.status, body: await response.json() };
  } catch (thrown) {
    if (thrown instanceof Response) return { status: thrown.status, body: await thrown.json() };
    throw thrown;
  }
}

function requestFor(token: string, url: string, init?: RequestInit & { branch?: string }) {
  const { branch, ...rest } = init ?? {};
  return new Request(`https://example.com${url}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(branch ? { "x-trigger-branch": branch } : {}),
    },
    ...rest,
  });
}

type CallOpts = { token: string; projectRef: string; env: string; branch?: string };

const commit = (opts: CallOpts & { runId: string }) =>
  respond(
    () =>
      commitLoader({
        request: requestFor(
          opts.token,
          `/api/v1/projects/${opts.projectRef}/${opts.env}/runs/${opts.runId}/commit`,
          { branch: opts.branch }
        ),
        params: { projectRef: opts.projectRef, env: opts.env, runId: opts.runId },
        context: {} as any,
      }) as Promise<Response>
  );

const snapshot = (opts: CallOpts) =>
  respond(
    () =>
      snapshotLoader({
        request: requestFor(
          opts.token,
          `/api/v1/projects/${opts.projectRef}/${opts.env}/repo/snapshot`,
          { branch: opts.branch }
        ),
        params: { projectRef: opts.projectRef, env: opts.env },
        context: {} as any,
      }) as Promise<Response>
  );

const worker = (opts: CallOpts) =>
  respond(
    () =>
      workerLoader({
        request: requestFor(
          opts.token,
          `/api/v1/projects/${opts.projectRef}/${opts.env}/workers/current`,
          { branch: opts.branch }
        ),
        params: { projectRef: opts.projectRef, env: opts.env, tagName: "current" },
        context: {} as any,
      }) as Promise<Response>
  );

const jwt = (opts: CallOpts & { body?: Record<string, unknown> }) =>
  respond(
    () =>
      jwtAction({
        request: requestFor(opts.token, `/api/v1/projects/${opts.projectRef}/${opts.env}/jwt`, {
          method: "POST",
          body: JSON.stringify(opts.body ?? {}),
          branch: opts.branch,
        }),
        params: { projectRef: opts.projectRef, env: opts.env },
        context: {} as any,
      }) as Promise<Response>
  );

const environments = (opts: { token: string; projectRef: string }) =>
  respond(
    () =>
      environmentsLoader({
        request: requestFor(opts.token, `/api/v1/projects/${opts.projectRef}/environments`),
        params: { projectRef: opts.projectRef },
        context: {} as any,
      }) as Promise<Response>
  );

const projects = (opts: { token: string; organizationId?: string }) =>
  respond(
    () =>
      projectsLoader({
        request: requestFor(
          opts.token,
          `/api/v1/projects${opts.organizationId ? `?organizationId=${opts.organizationId}` : ""}`
        ),
        params: {},
        context: {} as any,
      }) as Promise<Response>
  );

beforeEach(() => {
  mocks.assertSourcePatActive.mockReset();
  mocks.assertSourcePatActive.mockResolvedValue(true);
  forcedAbilityCan = undefined;
});

describe("an org-wide token reaches a sibling project across every UAT route", () => {
  postgresTest(
    "sibling, own, cross-org, and environment-only claims resolve the same way on every route",
    async ({ prisma }) => {
      ctx.prisma = prisma;
      const world = await seedWorld(prisma);

      const ROUTES = [
        {
          name: "run commit",
          call: (o: CallOpts) => commit({ ...o, runId: world.current.run.friendlyId }),
          callSibling: (o: CallOpts) => commit({ ...o, runId: world.sibling.run.friendlyId }),
          assertOwn: (body: any) => expect(body.sha).toBe("sha_current"),
          assertSibling: (body: any) => expect(body.sha).toBe("sha_sibling"),
        },
        {
          name: "repo snapshot",
          call: snapshot,
          callSibling: snapshot,
          assertOwn: (body: any) => expect(body.repo).toBe(world.current.project.id),
          assertSibling: (body: any) => expect(body.repo).toBe(world.sibling.project.id),
        },
        {
          name: "worker current",
          call: worker,
          callSibling: worker,
          assertOwn: (body: any) =>
            expect(body.worker.tasks.map((t: any) => t.slug)).toEqual(["current-prod-task"]),
          assertSibling: (body: any) =>
            expect(body.worker.tasks.map((t: any) => t.slug)).toEqual(["sibling-prod-task"]),
        },
      ];

      for (const route of ROUTES) {
        const minted = {
          userId: world.member.id,
          organizationId: world.orgA.id,
          environmentId: world.current.prod.id,
        };
        const token = await mintUat(minted);

        // A sibling project of the same org — the live repro. Its own content, not a 403.
        const sibling = await route.callSibling({
          token,
          projectRef: world.sibling.project.externalRef,
          env: "prod",
        });
        expect(sibling.status).toBe(200);
        route.assertSibling(sibling.body);

        // Its own project still works.
        const own = await route.call({
          token,
          projectRef: world.current.project.externalRef,
          env: "prod",
        });
        expect(own.status).toBe(200);
        route.assertOwn(own.body);

        // Another organization, reached by a user who belongs to both — the refusal is the org
        // boundary itself, not a missing membership.
        const crossToken = await mintUat({
          userId: world.crossMember.id,
          organizationId: world.orgA.id,
          environmentId: world.current.prod.id,
        });
        const foreign = await route.call({
          token: crossToken,
          projectRef: world.bProject.externalRef,
          env: "prod",
        });
        expect(foreign.status).toBe(403);
        expect(foreign.body.code).toBe("forbidden_environment");

        // Same claim, its own org: the very same user is admitted, so the 403 above is the
        // boundary.
        const crossOwn = await route.callSibling({
          token: crossToken,
          projectRef: world.sibling.project.externalRef,
          env: "prod",
        });
        expect(crossOwn.status).toBe(200);

        // An environment claim with no org claim is unchanged: its own environment only.
        const envOnlyToken = await mintUat({
          userId: world.member.id,
          environmentId: world.current.prod.id,
        });
        const scoped = await route.call({
          token: envOnlyToken,
          projectRef: world.current.project.externalRef,
          env: "prod",
        });
        expect(scoped.status).toBe(200);

        const scopedSibling = await route.callSibling({
          token: envOnlyToken,
          projectRef: world.sibling.project.externalRef,
          env: "prod",
        });
        expect(scopedSibling.status).toBe(403);
        expect(scopedSibling.body.code).toBe("forbidden_environment");

        // An org claim naming the right org still needs membership of it.
        const outsiderToken = await mintUat({
          userId: world.stranger.id,
          organizationId: world.orgA.id,
        });
        const outsider = await route.callSibling({
          token: outsiderToken,
          projectRef: world.sibling.project.externalRef,
          env: "prod",
        });
        expect(outsider.status).toBe(404);
      }

      // Route-specific extras: a preview branch of the sibling project, and another member's dev
      // env — org membership doesn't hand over a personal dev env.
      const minted = {
        userId: world.member.id,
        organizationId: world.orgA.id,
        environmentId: world.current.prod.id,
      };
      const token = await mintUat(minted);

      const branch = await worker({
        token,
        projectRef: world.sibling.project.externalRef,
        env: "preview",
        branch: "feat/sibling",
      });
      expect(branch.status).toBe(200);
      expect(branch.body.worker.tasks.map((t: any) => t.slug)).toEqual(["sibling-preview-task"]);

      const branchSnapshot = await snapshot({
        token,
        projectRef: world.sibling.project.externalRef,
        env: "preview",
        branch: "feat/sibling",
      });
      expect(branchSnapshot.status).toBe(200);
      expect(branchSnapshot.body.repo).toBe(world.sibling.project.id);

      // Another member's dev env: org membership doesn't hand it over. `crossMember` has no dev
      // row of their own on "sibling" — `member` now does, so this uses the one caller who can
      // prove that without accidentally hitting their own row instead.
      const noDevToken = await mintUat({
        userId: world.crossMember.id,
        organizationId: world.orgA.id,
        environmentId: world.current.prod.id,
      });
      const otherDevWorker = await worker({
        token: noDevToken,
        projectRef: world.sibling.project.externalRef,
        env: "dev",
      });
      expect(otherDevWorker.status).toBe(404);

      const otherDevSnapshot = await snapshot({
        token: noDevToken,
        projectRef: world.sibling.project.externalRef,
        env: "dev",
      });
      expect(otherDevSnapshot.status).toBe(404);

      // The control: without the opt-in, the same org-claim token is refused a sibling
      // environment, so the flag stays the only way in.
      const authenticationResult = {
        type: "personalAccessToken" as const,
        result: { userId: world.member.id },
        userActor: { ...minted, client: "dashboard-agent" },
      };
      await expect(
        authenticatedEnvironmentForAuthentication(
          authenticationResult,
          world.sibling.project.externalRef,
          "prod"
        )
      ).rejects.toMatchObject({ status: 403 });
    },
    60_000
  );
});

postgresTest(
  "an org-wide token lists a sibling project's environments and the org's projects",
  async ({ prisma }) => {
    ctx.prisma = prisma;
    const world = await seedWorld(prisma);
    const minted = {
      userId: world.member.id,
      organizationId: world.orgA.id,
      environmentId: world.current.dev.id,
    };
    const token = await mintUat(minted);

    // Every environment of a sibling project, dev included — the caller's own dev row, not the
    // second member's, and none of them the token's own environment.
    const sibling = await environments({ token, projectRef: world.sibling.project.externalRef });
    expect(sibling.status).toBe(200);
    expect(sibling.body.map((e: any) => e.slug).sort()).toEqual(["dev", "preview", "prod", "stg"]);

    // Its own project answers the same way: with an org claim, the org is the boundary.
    const own = await environments({ token, projectRef: world.current.project.externalRef });
    expect(own.status).toBe(200);
    expect(own.body.map((e: any) => e.slug).sort()).toEqual(["dev", "preview", "prod", "stg"]);

    // A project outside the claimed organization — routed through a member of both orgs so the
    // RBAC plugin's own membership floor doesn't intercept first; this exercises the route's own
    // org-scope check and its error shape.
    const crossEnvToken = await mintUat({
      userId: world.crossMember.id,
      organizationId: world.orgA.id,
    });
    const foreign = await environments({
      token: crossEnvToken,
      projectRef: world.bProject.externalRef,
    });
    expect(foreign.status).toBe(403);
    expect(foreign.body.code).toBe("forbidden_environment");

    // An org claim naming the right org still needs membership of it. This route resolves its
    // org before authenticating (its `context` looks the project up directly), so the RBAC
    // plugin's own membership floor turns a non-member away here — one layer earlier than the
    // route's own `findProjectByRef` check would.
    const outsiderToken = await mintUat({
      userId: world.stranger.id,
      organizationId: world.orgA.id,
    });
    const outsider = await environments({
      token: outsiderToken,
      projectRef: world.current.project.externalRef,
    });
    expect(outsider.status).toBe(403);

    // An environment claim with no org claim: that environment only, nothing in another project.
    const envOnlyToken = await mintUat({
      userId: world.member.id,
      environmentId: world.current.staging.id,
    });
    const scoped = await environments({
      token: envOnlyToken,
      projectRef: world.current.project.externalRef,
    });
    expect(scoped.status).toBe(200);
    expect(scoped.body.map((e: any) => e.slug)).toEqual(["stg"]);

    const scopedSibling = await environments({
      token: envOnlyToken,
      projectRef: world.sibling.project.externalRef,
    });
    expect(scopedSibling.status).toBe(403);
    expect(scopedSibling.body.code).toBe("forbidden_environment");

    // Control: a route that hasn't opted in refuses the same org-wide token.
    const claims = { ...minted, client: "dashboard-agent" };
    await expect(
      resolveUserActorEnvironmentScope(claims, { projectId: world.sibling.project.id })
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      assertUserActorScope(claims, {
        organizationId: world.orgA.id,
        projectId: world.sibling.project.id,
      })
    ).rejects.toMatchObject({ status: 403 });

    // The project list: an org claim narrows it to that organization, membership still required.
    const claimed = await projects({ token });
    expect(claimed.status).toBe(200);
    expect(claimed.body.map((p: any) => p.externalRef).sort()).toEqual(
      [world.current.project.externalRef, world.sibling.project.externalRef].sort()
    );

    // An explicit org that agrees with the claim is fine; one that disagrees is refused.
    const agreeing = await projects({ token, organizationId: world.orgA.id });
    expect(agreeing.status).toBe(200);
    const mismatched = await projects({ token, organizationId: world.orgB.id });
    expect(mismatched.status).toBe(403);
    expect(mismatched.body.code).toBe("forbidden_environment");

    // No org claim (a PAT's shape): every membership the user actually has — both of orgA's
    // projects, plus orgB's.
    const crossToken = await mintUat({
      userId: world.crossMember.id,
      client: "personal-access-token",
    });
    const claimless = await projects({ token: crossToken });
    expect(claimless.status).toBe(200);
    expect(claimless.body.map((p: any) => p.externalRef).sort()).toEqual(
      [
        world.current.project.externalRef,
        world.sibling.project.externalRef,
        world.bProject.externalRef,
      ].sort()
    );
  },
  60_000
);

postgresTest(
  "the env-JWT exchange mints across the org and stops at its edge",
  async ({ prisma }) => {
    ctx.prisma = prisma;
    const world = await seedWorld(prisma);
    const token = await mintUat({
      userId: world.member.id,
      organizationId: world.orgA.id,
      environmentId: world.current.dev.id,
    });

    async function subOf(response: { body: any }, apiKey: string) {
      const result = await validateJWT(response.body.token, apiKey);
      if (!result.ok) throw new Error("minted token failed validation");
      return result.payload.sub;
    }

    // The environment the turn is in.
    const own = await jwt({ token, projectRef: world.current.project.externalRef, env: "dev" });
    expect(own.status).toBe(200);
    expect(await subOf(own, world.current.dev.apiKey)).toBe(world.current.dev.id);

    // A sibling environment of the same organization.
    const sibling = await jwt({
      token,
      projectRef: world.current.project.externalRef,
      env: "prod",
    });
    expect(sibling.status).toBe(200);
    expect(await subOf(sibling, world.current.prod.apiKey)).toBe(world.current.prod.id);

    // Another organization's environment.
    const foreign = await jwt({ token, projectRef: world.bProject.externalRef, env: "prod" });
    expect(foreign.status).toBe(404);

    // A member of both orgs still can't reach the other org's environment with an orgA claim —
    // membership resolves the project, so this proves the claim's own org boundary.
    const crossToken = await mintUat({
      userId: world.crossMember.id,
      organizationId: world.orgA.id,
    });
    const crossForeign = await jwt({
      token: crossToken,
      projectRef: world.bProject.externalRef,
      env: "prod",
    });
    expect(crossForeign.status).toBe(403);
    expect(crossForeign.body.code).toBe("forbidden_environment");

    // A non-member of the claimed org.
    const outsiderToken = await mintUat({
      userId: world.stranger.id,
      organizationId: world.orgA.id,
    });
    const outsider = await jwt({
      token: outsiderToken,
      projectRef: world.current.project.externalRef,
      env: "prod",
    });
    // The project lookup is already membership-scoped, so a non-member never reaches the org check.
    expect(outsider.status).toBe(404);
  },
  60_000
);

postgresTest(
  "assertUserActorEnvironmentAccess is the floor beneath every route",
  async ({ prisma }) => {
    ctx.prisma = prisma;
    const world = await seedWorld(prisma);

    const orgClaims = { userId: world.member.id, organizationId: world.orgA.id };
    await expect(
      assertUserActorEnvironmentAccess(orgClaims, world.current.prod)
    ).resolves.toBeUndefined();
    await expect(
      assertUserActorEnvironmentAccess(orgClaims, world.current.staging)
    ).resolves.toBeUndefined();

    // Same org, but the user isn't a member of it.
    const outsiderClaims = { userId: world.stranger.id, organizationId: world.orgA.id };
    await expect(
      assertUserActorEnvironmentAccess(outsiderClaims, world.current.prod)
    ).rejects.toMatchObject({ status: 403 });

    // Another organization's environment, even for a member of the claimed org.
    await expect(assertUserActorEnvironmentAccess(orgClaims, world.bProd)).rejects.toMatchObject({
      status: 403,
    });

    // The environment-claim path is unchanged: its own environment only.
    const envClaims = { userId: world.member.id, environmentId: world.current.prod.id };
    await expect(
      assertUserActorEnvironmentAccess(envClaims, world.current.prod)
    ).resolves.toBeUndefined();
    await expect(
      assertUserActorEnvironmentAccess(envClaims, world.current.staging)
    ).rejects.toMatchObject({ status: 403 });

    // An env claim that matches wins; one that doesn't falls back to the org rule.
    const bothClaims = {
      userId: world.member.id,
      environmentId: world.current.prod.id,
      organizationId: world.orgA.id,
    };
    await expect(
      assertUserActorEnvironmentAccess(bothClaims, world.current.prod)
    ).resolves.toBeUndefined();
    await expect(
      assertUserActorEnvironmentAccess(bothClaims, world.current.staging)
    ).resolves.toBeUndefined();
    await expect(assertUserActorEnvironmentAccess(bothClaims, world.bProd)).rejects.toMatchObject({
      status: 403,
    });

    // A claimless caller is unaffected.
    await expect(
      assertUserActorEnvironmentAccess(undefined, world.current.prod)
    ).resolves.toBeUndefined();
  },
  60_000
);

describe("a user-actor token's environment scope, driven through every route", () => {
  postgresTest(
    "a token minted for another environment is refused, a matching or agnostic one isn't",
    async ({ prisma }) => {
      ctx.prisma = prisma;
      const world = await seedWorld(prisma);
      const CALLS: Record<string, (o: CallOpts) => Promise<{ status: number; body: any }>> = {
        jwt: (o) => jwt(o),
        snapshot: (o) => snapshot(o),
        worker: (o) => worker(o),
        commit: (o) =>
          commit({
            ...o,
            runId:
              o.env === "staging"
                ? world.current.stagingRun.friendlyId
                : world.current.run.friendlyId,
          }),
      };

      for (const [name, call] of Object.entries(CALLS)) {
        const forOther = await mintUat({
          userId: world.member.id,
          environmentId: world.current.prod.id,
        });
        const mismatched = await call({
          token: forOther,
          projectRef: world.current.project.externalRef,
          env: "staging",
        });
        expect(mismatched.status, `${name}: minted-for-another-env`).toBe(403);
        expect(mismatched.body.code).toBe("forbidden_environment");

        const matching = await call({
          token: forOther,
          projectRef: world.current.project.externalRef,
          env: "prod",
        });
        expect(matching.status, `${name}: minted-for-this-env`).toBe(200);

        // A mint that couldn't resolve an environment must not pass every gate.
        const claimless = await mintUat({ userId: world.member.id });
        const noClaim = await call({
          token: claimless,
          projectRef: world.current.project.externalRef,
          env: "staging",
        });
        expect(noClaim.status, `${name}: no-environment-claim`).toBe(403);

        // An environment-agnostic token from another client is unaffected.
        const agnostic = await mintUat({
          userId: world.member.id,
          client: "personal-access-token",
        });
        const fromPat = await call({
          token: agnostic,
          projectRef: world.current.project.externalRef,
          env: "staging",
        });
        expect(fromPat.status, `${name}: agnostic-client`).toBe(200);
      }

      // A caller with no user-actor token at all is unaffected.
      const resolved = await authenticatedEnvironmentForAuthentication(
        { type: "personalAccessToken", result: { userId: world.member.id } },
        world.current.project.externalRef,
        "stg"
      );
      expect(resolved.id).toBe(world.current.staging.id);

      // `assertUserActorEnvironment` throws only on a real mismatch.
      expect(() => assertUserActorEnvironment(undefined, world.current.prod.id)).not.toThrow();
      expect(() =>
        assertUserActorEnvironment({ userId: world.member.id }, world.current.prod.id)
      ).not.toThrow();
      expect(() =>
        assertUserActorEnvironment(
          { userId: world.member.id, environmentId: world.current.prod.id },
          world.current.prod.id
        )
      ).not.toThrow();
      expect(() =>
        assertUserActorEnvironment(
          { userId: world.member.id, environmentId: world.current.prod.id },
          world.current.staging.id
        )
      ).toThrow();
    },
    60_000
  );

  postgresTest(
    "every environment family: production, staging, and a preview/dev branch's own token",
    async ({ prisma }) => {
      ctx.prisma = prisma;
      const world = await seedWorld(prisma);

      const CASES = [
        { name: "production", env: "prod", target: world.current.prod },
        { name: "staging", env: "staging", target: world.current.staging },
        {
          name: "a preview branch",
          env: "preview",
          branch: "feat/current",
          target: world.current.previewBranch,
          fallsBackTo: world.current.previewParent,
        },
        {
          name: "a development branch",
          env: "dev",
          branch: "feat/current",
          target: world.current.devBranch,
          fallsBackTo: world.current.dev,
        },
      ];

      for (const { name, env, branch, target, fallsBackTo } of CASES) {
        const token = await mintUat({ userId: world.member.id, environmentId: target.id });

        const response = await jwt({
          token,
          projectRef: world.current.project.externalRef,
          env,
          branch,
        });
        expect(response.status, `${name}: mints for its own env`).toBe(200);
        // A branch's api key is its parent's — the resolver reads the parent to override it.
        const signingKey = fallsBackTo?.apiKey ?? target.apiKey;
        expect(await subFrom(response, signingKey)).toBe(target.id);

        const viaWorker = await worker({
          token,
          projectRef: world.current.project.externalRef,
          env,
          branch,
        });
        expect(viaWorker.status, `${name}: resolves on delegated reads too`).toBe(200);

        if (fallsBackTo) {
          // 403s the branch's token when the branch didn't travel with it.
          const noBranch = await jwt({ token, projectRef: world.current.project.externalRef, env });
          expect(noBranch.status, `${name}: branch header missing`).toBe(403);
          expect(noBranch.body.code).toBe("forbidden_environment");

          // 403s the parent's token when a branch did.
          const parentToken = await mintUat({
            userId: world.member.id,
            environmentId: fallsBackTo.id,
          });
          const withBranch = await jwt({
            token: parentToken,
            projectRef: world.current.project.externalRef,
            env,
            branch,
          });
          expect(withBranch.status, `${name}: parent token with the branch header`).toBe(403);
        }
      }
    },
    60_000
  );
});

function subFrom(response: { body: any }, apiKey: string) {
  return validateJWT(response.body.token, apiKey).then((result) => {
    if (!result.ok) throw new Error("minted token failed validation");
    return result.payload.sub;
  });
}

postgresTest(
  "the env-JWT exchange's cap is a ceiling, and PAT liveness gates every UAT route",
  async ({ prisma }) => {
    ctx.prisma = prisma;
    const world = await seedWorld(prisma);
    const ENV_A = world.current.prod;

    async function decoded(response: { status: number; body: any }) {
      expect(response.status).toBe(200);
      const result = await validateJWT(response.body.token, ENV_A.apiKey);
      if (!result.ok) throw new Error("minted token failed validation");
      return result.payload as { scopes?: string[]; exp?: number };
    }

    // A scope the cap doesn't carry is dropped; an empty request falls back to the whole cap.
    const capToken = await mintUat({
      userId: world.member.id,
      environmentId: ENV_A.id,
      cap: ["read:apiKeys", "read:runs", "read:deployments"],
    });
    const dropped = await decoded(
      await jwt({
        token: capToken,
        projectRef: world.current.project.externalRef,
        env: "prod",
        body: { claims: { scopes: ["read:runs", "write:runs"] } },
      })
    );
    expect(dropped.scopes).toEqual(["read:runs"]);
    const fullCap = await decoded(
      await jwt({ token: capToken, projectRef: world.current.project.externalRef, env: "prod" })
    );
    expect(fullCap.scopes).toEqual(["read:apiKeys", "read:runs", "read:deployments"]);

    // A capless token defaults to the read-only ceiling and can't be projected past it.
    async function capless(body: Record<string, unknown>) {
      const token = await signUserActorToken(SESSION_SECRET, {
        userId: world.member.id,
        client: "dashboard-agent",
        environmentId: ENV_A.id,
      });
      return decoded(
        await jwt({ token, projectRef: world.current.project.externalRef, env: "prod", body })
      );
    }
    const deniedAdmin = await capless({ claims: { scopes: ["admin"] } });
    expect(deniedAdmin.scopes).toEqual([]);
    const admittedRead = await capless({ claims: { scopes: ["read:runs"] } });
    expect(admittedRead.scopes).toEqual(["read:runs"]);
    const defaulted = await capless({});
    expect(defaulted.scopes).toEqual(["read:all"]);

    // A capped token's requested scopes pass through unchanged when the cap carries them.
    // `read:apiKeys` rides along on every mint here — the exchange's own gate needs it,
    // independent of the scope-projection math under test.
    async function withCap(cap: string[], scopes: string[]) {
      const token = await signUserActorToken(SESSION_SECRET, {
        userId: world.member.id,
        client: "dashboard-agent",
        environmentId: ENV_A.id,
        cap: [...cap, "read:apiKeys"],
      });
      return decoded(
        await jwt({
          token,
          projectRef: world.current.project.externalRef,
          env: "prod",
          body: { claims: { scopes } },
        })
      );
    }
    expect(
      (await withCap(["read:runs", "read:apiKeys"], ["read:runs", "read:apiKeys"])).scopes
    ).toEqual(["read:runs", "read:apiKeys"]);
    expect((await withCap(["read:runs"], ["read:runs", "write:runs"])).scopes).toEqual([
      "read:runs",
    ]);
    expect((await withCap(["write:errors"], ["write:errors"])).scopes).toEqual(["write:errors"]);

    // A non-UAT (PAT) exchange's scopes travel untouched.
    patBearerUserId = world.member.id;
    const requested = ["read:runs", "write:runs", "admin"];
    const patResult = await decoded(
      await jwt({
        token: "tr_pat_e2e_token",
        projectRef: world.current.project.externalRef,
        env: "prod",
        body: { claims: { scopes: requested } },
      })
    );
    expect(patResult.scopes).toEqual(requested);

    // The minted JWT's lifetime is clamped to the token's own expiry.
    const nowSec = Math.floor(Date.now() / 1000);
    const tokenExp = nowSec + 600;
    const clampToken = await signUserActorToken(SESSION_SECRET, {
      userId: world.member.id,
      client: "dashboard-agent",
      environmentId: ENV_A.id,
      expirationTime: tokenExp,
    });
    const clamped = await decoded(
      await jwt({
        token: clampToken,
        projectRef: world.current.project.externalRef,
        env: "prod",
        body: { expirationTime: "365d" },
      })
    );
    expect(clamped.exp).toBeLessThanOrEqual(tokenExp + 1);
    expect(clamped.exp).toBeGreaterThan(nowSec + 500);

    // Repo-snapshot authorization: gated on the same `read:apiKeys` cap as the JWT exchange.
    const noApiKeysCap = await mintUat({
      userId: world.member.id,
      environmentId: ENV_A.id,
      cap: ["read:runs"],
    });
    const denied = await snapshot({
      token: noApiKeysCap,
      projectRef: world.current.project.externalRef,
      env: "prod",
    });
    expect(denied.status).toBe(403);
    const served = await snapshot({
      token: capToken,
      projectRef: world.current.project.externalRef,
      env: "prod",
    });
    expect(served.status).toBe(200);
    expect(served.body).toMatchObject({ repo: world.current.project.id });

    // A token whose source PAT is no longer live is turned away, on both the JWT exchange and
    // the shared UAT preamble that fronts the repo-snapshot / workers / commit reads.
    mocks.assertSourcePatActive.mockResolvedValueOnce(false);
    const jwtDenied = await jwt({
      token: capToken,
      projectRef: world.current.project.externalRef,
      env: "prod",
    });
    expect(jwtDenied.status).toBe(401);

    mocks.assertSourcePatActive.mockResolvedValueOnce(false);
    const snapshotDenied = await snapshot({
      token: capToken,
      projectRef: world.current.project.externalRef,
      env: "prod",
    });
    expect(snapshotDenied.status).toBe(401);

    const snapshotServed = await snapshot({
      token: capToken,
      projectRef: world.current.project.externalRef,
      env: "prod",
    });
    expect(snapshotServed.status).toBe(200);
  },
  60_000
);

postgresTest(
  "repo-snapshot authorization denies a role the ability itself refuses",
  async ({ prisma }) => {
    ctx.prisma = prisma;
    const world = await seedWorld(prisma);
    // The OSS fallback's ability is otherwise cap-driven (UAT) or permissive (PAT), so a role
    // that fails `can()` independent of cap is forced here rather than reachable for real.
    forcedAbilityCan = () => false;
    mocks.resolveDashboardAgentRepoSnapshot.mockClear();

    const token = await mintUat({ userId: world.member.id, environmentId: world.current.prod.id });
    const denied = await snapshot({
      token,
      projectRef: world.current.project.externalRef,
      env: "prod",
    });

    expect(denied.status).toBe(403);
    expect(mocks.resolveDashboardAgentRepoSnapshot).not.toHaveBeenCalled();
  },
  60_000
);

describe("resolveAgentTokenScope", () => {
  it("pins an environment-only token and ignores the request", () => {
    const scope = resolveAgentTokenScope(
      { environmentId: "env_token" },
      { environmentId: "env_other" }
    );
    expect(scope).toEqual({ ok: true, environmentId: "env_token" });
  });

  it("honours the request environment for an org-wide token", () => {
    const scope = resolveAgentTokenScope(
      { environmentId: "env_current", organizationId: "org_1" },
      { environmentId: "env_elsewhere" }
    );
    expect(scope).toEqual({ ok: true, environmentId: "env_elsewhere", organizationId: "org_1" });
  });

  it("hands back the org so the caller can reject another org's environment", () => {
    const scope = resolveAgentTokenScope({ organizationId: "org_1" }, { environmentId: "env_x" });
    expect(scope).toEqual({ ok: true, environmentId: "env_x", organizationId: "org_1" });
  });

  it("defaults to the token's environment when the request names none", () => {
    const scope = resolveAgentTokenScope(
      { environmentId: "env_current", organizationId: "org_1" },
      {}
    );
    expect(scope).toEqual({ ok: true, environmentId: "env_current", organizationId: "org_1" });
  });

  it("refuses an org-only token with no environment to default to", () => {
    expect(resolveAgentTokenScope({ organizationId: "org_1" }, {}).ok).toBe(false);
  });

  it("refuses a token with no scope at all", () => {
    expect(resolveAgentTokenScope({}, { environmentId: "env_named" }).ok).toBe(false);
  });
});

describe("the dashboard agent's delegated token", () => {
  it("carries the organization as well as the environment", async () => {
    const token = await mintDashboardAgentUserActorToken("user_1", {
      environmentId: "env_1",
      organizationId: "org_1",
    });

    const claims = await verifyUserActorToken(SESSION_SECRET, token);
    expect(claims?.userId).toBe("user_1");
    expect(claims?.client).toBe("dashboard-agent");
    expect(claims?.environmentId).toBe("env_1");
    expect(claims?.organizationId).toBe("org_1");
    expect(claims?.cap).toEqual(DASHBOARD_AGENT_UAT_CAP);
  });
});
