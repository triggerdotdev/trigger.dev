/**
 * The agent's org-wide locator: an object it could not find in the current project/environment is
 * looked up across the token's organization, and never beyond it. Driven through the real loader
 * against a real Postgres and a real ClickHouse, because membership is the tenant floor.
 */

import type { PrismaClient } from "@trigger.dev/database";
import { expect, vi } from "vitest";

const SESSION_SECRET = "test-session-secret";

const ctx = vi.hoisted(() => ({
  prisma: undefined as unknown as PrismaClient,
  clickhouse: undefined as any,
}));

vi.mock("~/db.server", () => {
  const proxy = new Proxy(
    {},
    { get: (_target, prop) => (ctx.prisma as unknown as Record<string, unknown>)[prop as string] }
  );
  return { prisma: proxy, $replica: proxy, sqlDatabaseSchema: undefined };
});

// A real store over the test database — the singleton would read boot env instead.
vi.mock("~/v3/runStore.server", async () => {
  const { PostgresRunStore } = await import("@internal/run-store");
  return {
    get runStore() {
      return new PostgresRunStore({
        prisma: ctx.prisma as any,
        readOnlyPrisma: ctx.prisma as any,
      });
    },
  };
});

vi.mock("~/services/clickhouse/clickhouseFactoryInstance.server", () => ({
  clickhouseFactory: { getClickhouseForOrganization: async () => ctx.clickhouse },
}));

vi.mock("~/env.server", () => ({ env: { SESSION_SECRET: "test-session-secret" } }));
vi.mock("~/services/rbac.server", () => ({
  rbac: { authenticateUserActor: vi.fn(), authenticatePat: vi.fn() },
}));
vi.mock("~/services/personalAccessToken.server", () => ({
  assertSourcePatActive: async () => true,
  updateLastAccessedAtIfStale: vi.fn(),
  resolveAndRecheckUserActorClaims: vi.fn(),
  // A real PAT authenticates a user but carries no actor claims, so it never reaches the locator.
  isPersonalAccessToken: (token: string) => token.startsWith("tr_pat_"),
  authenticateApiRequestWithPersonalAccessToken: async () => ({ userId: "user_with_a_pat" }),
}));
vi.mock("~/services/authTelemetry.server", () => ({
  authenticateBearerWithTelemetry: vi.fn(),
}));
vi.mock("~/services/logger.server", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock("~/services/tenantContext.server", () => ({
  tenantContext: { enrich: vi.fn() },
  tenantContextFromAuthEnvironment: vi.fn(),
}));
vi.mock("~/v3/services/worker/workerGroupTokenService.server", () => ({
  WorkerGroupTokenService: class {},
}));
vi.mock("~/v3/services/common.server", () => ({
  ServiceValidationError: class extends Error {},
}));
vi.mock("@internal/run-engine", () => ({
  EngineServiceValidationError: class extends Error {},
}));

import { ClickHouse } from "@internal/clickhouse";
import { containerTest } from "@internal/testcontainers";
import { signUserActorToken } from "@trigger.dev/rbac";
import { z } from "zod";

const { loader } = await import("~/routes/api.v1.locate.$kind.$id");

vi.setConfig({ testTimeout: 90_000 });

function suffix() {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * An org with two projects. Each carries the whole environment family the locator has to name:
 * prod, staging, a dev root per member, a preview root, and branch children of both branchable
 * types — plus one archived preview branch.
 */
async function seedOrg(prisma: PrismaClient) {
  const slug = `locate_${suffix()}`;
  const member = await prisma.user.create({
    data: { email: `${slug}-member@example.com`, authenticationMethod: "MAGIC_LINK" },
  });
  const other = await prisma.user.create({
    data: { email: `${slug}-other@example.com`, authenticationMethod: "MAGIC_LINK" },
  });
  const organization = await prisma.organization.create({ data: { title: slug, slug } });
  const memberOf = await prisma.orgMember.create({
    data: { organizationId: organization.id, userId: member.id, role: "ADMIN" },
  });
  const otherMemberOf = await prisma.orgMember.create({
    data: { organizationId: organization.id, userId: other.id, role: "MEMBER" },
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

    const environmentFor = (
      envSlug: string,
      type: "PRODUCTION" | "STAGING" | "PREVIEW" | "DEVELOPMENT",
      extra?: {
        orgMemberId?: string;
        parentEnvironmentId?: string;
        branchName?: string;
        archivedAt?: Date;
      }
    ) =>
      prisma.runtimeEnvironment.create({
        data: {
          slug: envSlug,
          type,
          projectId: project.id,
          organizationId: organization.id,
          apiKey: `tr_${envSlug}_${projectSlug}_${suffix()}`,
          pkApiKey: `pk_${envSlug}_${projectSlug}_${suffix()}`,
          shortcode: `${envSlug}${suffix()}`,
          ...extra,
        },
        select: { id: true, slug: true },
      });

    const ownDev = await environmentFor("dev", "DEVELOPMENT", { orgMemberId: memberOf.id });
    const previewRoot = await environmentFor("preview", "PREVIEW");

    return {
      project,
      prod: await environmentFor("prod", "PRODUCTION"),
      // The dashboard slug for staging is "stg"; the API name is "staging".
      staging: await environmentFor("stg", "STAGING"),
      ownDev,
      otherDev: await environmentFor("dev", "DEVELOPMENT", { orgMemberId: otherMemberOf.id }),
      previewRoot,
      previewBranch: await environmentFor("preview-feat-a", "PREVIEW", {
        parentEnvironmentId: previewRoot.id,
        branchName: "feat/a",
      }),
      archivedPreviewBranch: await environmentFor("preview-feat-old", "PREVIEW", {
        parentEnvironmentId: previewRoot.id,
        branchName: "feat/old",
        archivedAt: new Date(),
      }),
      devBranch: await environmentFor("dev-feat-a", "DEVELOPMENT", {
        orgMemberId: memberOf.id,
        parentEnvironmentId: ownDev.id,
        branchName: "feat/a",
      }),
    };
  }

  return {
    member,
    other,
    organization,
    current: await projectWithEnvironments("current"),
    sibling: await projectWithEnvironments("sibling"),
  };
}

async function createRun(
  prisma: PrismaClient,
  scope: { organizationId: string; projectId: string },
  environmentId: string
) {
  const friendlyId = `run_${suffix()}`;
  return prisma.taskRun.create({
    data: {
      friendlyId,
      taskIdentifier: "my-task",
      status: "COMPLETED_WITH_ERRORS",
      payload: "{}",
      traceId: friendlyId,
      spanId: friendlyId,
      queue: "test",
      runTags: [],
      runtimeEnvironmentId: environmentId,
      projectId: scope.projectId,
      organizationId: scope.organizationId,
      environmentType: "PRODUCTION",
      engine: "V2",
    },
  });
}

function scopeOf(org: { organization: { id: string } }, bundle: { project: { id: string } }) {
  return { organizationId: org.organization.id, projectId: bundle.project.id };
}

/** Failed runs in ClickHouse; the errors_v1 materialized view derives the fingerprint groups. */
async function insertFailedRuns(
  clickhouse: ClickHouse,
  rows: Array<{
    organizationId: string;
    projectId: string;
    environmentId: string;
    fingerprint: string;
  }>
) {
  const insert = clickhouse.writer.insert({
    name: "insertLocateTestTaskRuns",
    table: "trigger_dev.task_runs_v2",
    schema: z.any(),
    settings: { async_insert: 0, enable_json_type: 1, type_json_skip_duplicated_paths: 1 },
  });

  const now = Date.now();
  const [error] = await insert(
    rows.map((row, index) => ({
      environment_id: row.environmentId,
      organization_id: row.organizationId,
      project_id: row.projectId,
      run_id: `run_${index}_${suffix()}`,
      friendly_id: `run_${index}_${suffix()}`,
      updated_at: now,
      created_at: now,
      status: "COMPLETED_WITH_ERRORS",
      environment_type: "PRODUCTION",
      attempt: 1,
      engine: "V2",
      task_identifier: "my-task",
      queue: "test",
      schedule_id: "",
      batch_id: "",
      task_version: "1.0.0",
      sdk_version: "",
      cli_version: "",
      machine_preset: "",
      root_run_id: "",
      parent_run_id: "",
      span_id: `span_${index}`,
      trace_id: `trace_${index}`,
      idempotency_key: "",
      expiration_ttl: "",
      error_fingerprint: row.fingerprint,
      tags: [],
      worker_queue: "main",
      region: "",
      _version: String(now),
      _is_deleted: 0,
    }))
  );

  if (error) {
    throw error;
  }
}

async function callLoader(opts: {
  kind: string;
  id: string;
  userId?: string;
  organizationId?: string;
  bearer?: string;
}) {
  const token = opts.bearer
    ? opts.bearer
    : opts.userId
      ? await signUserActorToken(SESSION_SECRET, {
          userId: opts.userId,
          client: "dashboard-agent",
          cap: ["read:runs"],
          ...(opts.organizationId ? { organizationId: opts.organizationId } : {}),
        } as any)
      : undefined;

  const response = await loader({
    request: new Request(`https://api.trigger.dev/api/v1/locate/${opts.kind}/${opts.id}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }),
    params: { kind: opts.kind, id: opts.id },
    context: {},
  } as any);

  return { status: response.status, body: (await response.json()) as any };
}

containerTest(
  "locates a run across the token organization, and no further",
  async ({ prisma, clickhouseContainer }) => {
    ctx.prisma = prisma;
    ctx.clickhouse = new ClickHouse({
      url: clickhouseContainer.getConnectionUrl(),
      name: "locate-agent-run-test",
      compression: { request: true },
    });

    const orgA = await seedOrg(prisma);
    const orgB = await seedOrg(prisma);
    const caller = { userId: orgA.member.id, organizationId: orgA.organization.id };

    // A sibling project's production environment — the sweep this endpoint replaces.
    const siblingRun = await createRun(prisma, scopeOf(orgA, orgA.sibling), orgA.sibling.prod.id);
    const found = await callLoader({ kind: "run", id: siblingRun.friendlyId, ...caller });

    expect(found.status).toBe(200);
    expect(found.body.checked).toBe("organization");
    expect(found.body.scopes).toEqual([
      {
        projectRef: orgA.sibling.project.externalRef,
        projectName: orgA.sibling.project.name,
        environmentName: "prod",
        environmentType: "PRODUCTION",
        targetable: true,
      },
    ]);

    // Another member's dev environment exists, but the caller can't act in it.
    const otherDevRun = await createRun(
      prisma,
      scopeOf(orgA, orgA.current),
      orgA.current.otherDev.id
    );
    const otherDev = await callLoader({ kind: "run", id: otherDevRun.friendlyId, ...caller });
    expect(otherDev.status).toBe(200);
    expect(otherDev.body.scopes).toHaveLength(1);
    expect(otherDev.body.scopes[0].targetable).toBe(false);

    // The caller's own dev environment in the same project is targetable.
    const ownDevRun = await createRun(prisma, scopeOf(orgA, orgA.current), orgA.current.ownDev.id);
    const ownDev = await callLoader({ kind: "run", id: ownDevRun.friendlyId, ...caller });
    expect(ownDev.body.scopes[0].targetable).toBe(true);

    // Staging's dashboard slug is "stg"; the address the agent has to use is "staging".
    const stagingRun = await createRun(
      prisma,
      scopeOf(orgA, orgA.current),
      orgA.current.staging.id
    );
    const staging = await callLoader({ kind: "run", id: stagingRun.friendlyId, ...caller });
    expect(staging.body.scopes[0]).toMatchObject({
      environmentName: "staging",
      environmentType: "STAGING",
      targetable: true,
    });
    expect(staging.body.scopes[0].branchName).toBeUndefined();

    // A preview branch child: the name is the family, the branch is the rest of the address.
    const previewBranchRun = await createRun(
      prisma,
      scopeOf(orgA, orgA.current),
      orgA.current.previewBranch.id
    );
    const previewBranch = await callLoader({
      kind: "run",
      id: previewBranchRun.friendlyId,
      ...caller,
    });
    expect(previewBranch.body.scopes[0]).toEqual({
      projectRef: orgA.current.project.externalRef,
      projectName: orgA.current.project.name,
      environmentName: "preview",
      environmentType: "PREVIEW",
      branchName: "feat/a",
      targetable: true,
    });

    // A dev branch child of the caller's own dev root.
    const devBranchRun = await createRun(
      prisma,
      scopeOf(orgA, orgA.current),
      orgA.current.devBranch.id
    );
    const devBranch = await callLoader({ kind: "run", id: devBranchRun.friendlyId, ...caller });
    expect(devBranch.body.scopes[0]).toMatchObject({
      environmentName: "dev",
      environmentType: "DEVELOPMENT",
      branchName: "feat/a",
      targetable: true,
    });

    // An archived branch still exists, so the run is located, it just can't be acted in.
    const archivedRun = await createRun(
      prisma,
      scopeOf(orgA, orgA.current),
      orgA.current.archivedPreviewBranch.id
    );
    const archived = await callLoader({ kind: "run", id: archivedRun.friendlyId, ...caller });
    expect(archived.body.found).toBe(true);
    expect(archived.body.scopes[0]).toMatchObject({
      environmentName: "preview",
      branchName: "feat/old",
      targetable: false,
    });

    // A run in another organization must not even be confirmed to exist.
    const foreignRun = await createRun(prisma, scopeOf(orgB, orgB.current), orgB.current.prod.id);
    const foreign = await callLoader({ kind: "run", id: foreignRun.friendlyId, ...caller });
    expect(foreign.body).toEqual({ found: false, checked: "organization" });

    // An id that exists nowhere reads the same way.
    const unknown = await callLoader({ kind: "run", id: "run_nowhere", ...caller });
    expect(unknown.body).toEqual({ found: false, checked: "organization" });

    // No token, and a token carrying no organization claim, are both unauthenticated here.
    expect((await callLoader({ kind: "run", id: siblingRun.friendlyId })).status).toBe(401);
    expect(
      (await callLoader({ kind: "run", id: siblingRun.friendlyId, userId: orgA.member.id })).status
    ).toBe(401);

    // A plain PAT authenticates a user but carries no actor claims, so it locates nothing.
    expect(
      (await callLoader({ kind: "run", id: siblingRun.friendlyId, bearer: "tr_pat_not_an_actor" }))
        .status
    ).toBe(401);

    // A claim naming an organization the caller doesn't belong to.
    const outsider = await callLoader({
      kind: "run",
      id: siblingRun.friendlyId,
      userId: orgB.other.id,
      organizationId: orgA.organization.id,
    });
    expect(outsider.status).toBe(403);

    // An unknown object kind is a bad request, not a silent not-found.
    expect((await callLoader({ kind: "queue", id: "task/my-task", ...caller })).status).toBe(400);
  }
);

containerTest(
  "locates an error group in every environment of the organization it occurs in",
  async ({ prisma, clickhouseContainer }) => {
    ctx.prisma = prisma;
    const clickhouse = new ClickHouse({
      url: clickhouseContainer.getConnectionUrl(),
      name: "locate-agent-error-test",
      compression: { request: true },
    });
    ctx.clickhouse = clickhouse;

    const orgA = await seedOrg(prisma);
    const orgB = await seedOrg(prisma);
    const fingerprint = `fp${suffix()}`;

    await insertFailedRuns(clickhouse, [
      {
        organizationId: orgA.organization.id,
        projectId: orgA.current.project.id,
        environmentId: orgA.current.prod.id,
        fingerprint,
      },
      {
        organizationId: orgA.organization.id,
        projectId: orgA.sibling.project.id,
        environmentId: orgA.sibling.prod.id,
        fingerprint,
      },
      // The same fingerprint in another organization: outside the boundary, so never reported.
      {
        organizationId: orgB.organization.id,
        projectId: orgB.current.project.id,
        environmentId: orgB.current.prod.id,
        fingerprint,
      },
    ]);

    const located = await callLoader({
      kind: "error",
      id: `error_${fingerprint}`,
      userId: orgA.member.id,
      organizationId: orgA.organization.id,
    });

    expect(located.status).toBe(200);
    expect(located.body.found).toBe(true);
    expect(located.body.scopes.map((scope: any) => scope.projectRef).sort()).toEqual(
      [orgA.current.project.externalRef, orgA.sibling.project.externalRef].sort()
    );
    expect(located.body.scopes.every((scope: any) => scope.targetable)).toBe(true);

    const unknown = await callLoader({
      kind: "error",
      id: `error_fp${suffix()}`,
      userId: orgA.member.id,
      organizationId: orgA.organization.id,
    });
    expect(unknown.body).toEqual({ found: false, checked: "organization" });
  }
);
