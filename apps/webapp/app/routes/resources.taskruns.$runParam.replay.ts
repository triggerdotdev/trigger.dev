import { parseWithZod } from "@conform-to/zod/v4";
import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { type EnvironmentType, prettyPrintPacket } from "@trigger.dev/core/v3";
import { typedjson } from "remix-typedjson";
import { z } from "zod";
import { $replica, prisma } from "~/db.server";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { displayableEnvironment } from "~/models/runtimeEnvironment.server";
import { logger } from "~/services/logger.server";
import { requireUser } from "~/services/session.server";
import { dashboardAction } from "~/services/routeBuilders/dashboardBuilder";
import { sortEnvironments } from "~/utils/environmentSort";
import { v3RunSpanPath } from "~/utils/pathBuilder";
import { ReplayTaskRunService } from "~/v3/services/replayTaskRun.server";
import { getMollifierBuffer } from "~/v3/mollifier/mollifierBuffer.server";
import { findRunByIdWithMollifierFallback } from "~/v3/mollifier/readFallback.server";
import {
  buildSyntheticReplayTaskRun,
  type SyntheticReplayTaskRun,
} from "~/v3/mollifier/syntheticReplayTaskRun.server";
import parseDuration from "parse-duration";
import { regionForDisplay } from "~/runEngine/concerns/workerQueueSplit.server";
import { findCurrentWorkerDeployment } from "~/v3/models/workerDeployment.server";
import { queueTypeFromType } from "~/presenters/v3/QueueRetrievePresenter.server";
import { ReplayRunData } from "~/v3/replayTask";
import { RegionsPresenter } from "~/presenters/v3/RegionsPresenter.server";
import { runStore } from "~/v3/runStore.server";

const ParamSchema = z.object({
  runParam: z.string(),
});

const QuerySchema = z.object({
  environmentIdOverride: z.string().optional(),
});

export async function loader({ request, params }: LoaderFunctionArgs) {
  const user = await requireUser(request);
  const userId = user.id;
  const { runParam } = ParamSchema.parse(params);
  const { environmentIdOverride } = QuerySchema.parse(
    Object.fromEntries(new URL(request.url).searchParams)
  );

  let run = await runStore.findRun(
    { friendlyId: runParam, project: { organization: { members: { some: { userId } } } } },
    {
      select: {
        payload: true,
        payloadType: true,
        seedMetadata: true,
        seedMetadataType: true,
        runtimeEnvironmentId: true,
        concurrencyKey: true,
        maxAttempts: true,
        maxDurationInSeconds: true,
        machinePreset: true,
        workerQueue: true,
        region: true,
        ttl: true,
        idempotencyKey: true,
        runTags: true,
        queue: true,
        taskIdentifier: true,
        project: {
          select: {
            slug: true,
            environments: {
              select: {
                id: true,
                type: true,
                slug: true,
                branchName: true,
                parentEnvironmentId: true,
                orgMember: {
                  select: {
                    user: true,
                  },
                },
              },
              where: {
                archivedAt: null,
                OR: [
                  {
                    type: {
                      in: ["PREVIEW", "STAGING", "PRODUCTION"],
                    },
                  },
                  {
                    type: "DEVELOPMENT",
                    orgMember: {
                      userId,
                    },
                  },
                ],
              },
            },
          },
        },
      },
    },
    $replica
  );

  let synthetic:
    | (Awaited<ReturnType<typeof findRunByIdWithMollifierFallback>> & { __synth: true })
    | undefined;
  if (!run) {
    // Buffered fallback: read the snapshot and look up the env list via
    // the snapshot's organizationId. Without this the Replay dialog
    // 404s for runs queued in the mollifier buffer, which dumps the
    // user back to the task list.
    const buffer = getMollifierBuffer();
    const entry = buffer ? await buffer.getEntry(runParam) : null;
    if (!entry) throw new Response("Not Found", { status: 404 });
    const member = await prisma.orgMember.findFirst({
      where: { userId, organizationId: entry.orgId },
      select: { id: true },
    });
    if (!member) throw new Response("Not Found", { status: 404 });
    const buffered = await findRunByIdWithMollifierFallback({
      runId: runParam,
      environmentId: entry.envId,
      organizationId: entry.orgId,
    });
    if (!buffered) throw new Response("Not Found", { status: 404 });
    synthetic = Object.assign(buffered, { __synth: true as const });
    // Scope the project lookup to the buffer entry's org as well as the
    // env id. The prior `orgMember.findFirst` above confirms the user
    // belongs to `entry.orgId`; pinning `organizationId` here means a
    // malformed entry whose envId resolves to a different org can't leak
    // that project's data through this loader. Mirrors the PG path's
    // `project.organization.members.some.userId` scoping (lines 42-95)
    // — the env filter and select shape are kept identical so the Replay
    // dialog renders the same dropdown either way.
    const orgProject = await $replica.project.findFirst({
      where: {
        organizationId: entry.orgId,
        environments: { some: { id: entry.envId } },
      },
      select: {
        slug: true,
        environments: {
          select: {
            id: true,
            type: true,
            slug: true,
            branchName: true,
            parentEnvironmentId: true,
            orgMember: { select: { user: true } },
          },
          where: {
            archivedAt: null,
            OR: [
              { type: { in: ["PREVIEW", "STAGING", "PRODUCTION"] } },
              { type: "DEVELOPMENT", orgMember: { userId } },
            ],
          },
        },
      },
    });
    if (!orgProject) throw new Response("Not Found", { status: 404 });
    run = {
      payload: buffered.payload,
      payloadType: buffered.payloadType ?? "application/json",
      seedMetadata: buffered.seedMetadata ?? null,
      seedMetadataType: buffered.seedMetadataType ?? null,
      runtimeEnvironmentId: entry.envId,
      concurrencyKey: buffered.concurrencyKey ?? null,
      maxAttempts: buffered.maxAttempts ?? null,
      maxDurationInSeconds: buffered.maxDurationInSeconds ?? null,
      machinePreset: buffered.machinePreset ?? null,
      workerQueue: buffered.workerQueue ?? null,
      region: buffered.region ?? null,
      ttl: buffered.ttl ?? null,
      idempotencyKey: buffered.idempotencyKey ?? null,
      runTags: buffered.runTags,
      queue: buffered.queue ?? "task/",
      taskIdentifier: buffered.taskIdentifier ?? "",
      project: orgProject,
    } as unknown as typeof run;
  }

  if (!run) {
    throw new Response("Not Found", { status: 404 });
  }

  const runEnvironment = run.project.environments.find(
    (env) => env.id === run.runtimeEnvironmentId
  );
  const environmentOverride = run.project.environments.find(
    (env) => env.id === environmentIdOverride
  );
  const environment = environmentOverride ?? runEnvironment;
  if (!environment) {
    throw new Response("Environment not found", { status: 404 });
  }

  const [taskQueue, backgroundWorkers] = await Promise.all([
    findTaskQueue(environment, run.taskIdentifier),
    listLatestBackgroundWorkers(environment),
  ]);

  const latestVersions = backgroundWorkers.map((v) => v.version);
  const disableVersionSelection = environment.type === "DEVELOPMENT";
  const allowArbitraryQueues = backgroundWorkers.at(0)?.engine === "V1";

  const [payload, regionsResult] = await Promise.all([
    prettyPrintPacket(run.payload, run.payloadType),
    new RegionsPresenter().call({
      userId,
      projectSlug: run.project.slug,
      isAdmin: user.admin || user.isImpersonating,
    }),
  ]);

  return typedjson({
    concurrencyKey: run.concurrencyKey,
    maxAttempts: run.maxAttempts,
    maxDurationSeconds: run.maxDurationInSeconds,
    machinePreset: run.machinePreset,
    region:
      environment.type === "DEVELOPMENT"
        ? undefined
        : regionForDisplay(run.region, run.workerQueue),
    regions: regionsResult.regions,
    ttlSeconds: run.ttl ? (parseDuration(run.ttl, "s") ?? undefined) : undefined,
    idempotencyKey: run.idempotencyKey,
    runTags: run.runTags,
    payload,
    payloadType: run.payloadType,
    queue: run.queue,
    metadata: run.seedMetadata
      ? await prettyPrintPacket(run.seedMetadata, run.seedMetadataType)
      : undefined,
    defaultTaskQueue: taskQueue
      ? {
          id: taskQueue.friendlyId,
          name: taskQueue.name.replace(/^task\//, ""),
          type: queueTypeFromType(taskQueue.type),
          paused: taskQueue.paused,
        }
      : undefined,
    latestVersions,
    disableVersionSelection,
    allowArbitraryQueues,
    environment: {
      ...displayableEnvironment(environment, userId),
      branchName: environment.branchName ?? undefined,
    },
    environments: sortEnvironments(
      run.project.environments
        .filter((env) => env.type !== "PREVIEW" || env.parentEnvironmentId !== null)
        .map((env) => ({
          ...displayableEnvironment(env, userId),
          branchName: env.branchName ?? undefined,
        }))
    ),
  });
}

// Resolve the run's organization so the RBAC auth scope can resolve the
// user's role in it. The run may not be in Postgres yet (buffered during a
// burst), so fall back to the buffer entry's org.
async function resolveRunOrganizationId(runParam: string): Promise<string | null> {
  const run = await runStore.findRun(
    { friendlyId: runParam },
    { select: { project: { select: { organizationId: true } } } },
    $replica
  );
  if (run) {
    return run.project.organizationId;
  }

  const buffer = getMollifierBuffer();
  const entry = buffer ? await buffer.getEntry(runParam) : null;
  if (entry?.orgId) {
    return entry.orgId;
  }

  // Replica lag with the buffer entry already drained: the run can exist in
  // the primary while both lookups above miss. Fall back to the primary so the
  // RBAC scope is never resolved without an org (which would let the role check
  // run unscoped under the RBAC plugin).
  const primaryRun = await runStore.findRun(
    { friendlyId: runParam },
    { select: { project: { select: { organizationId: true } } } },
    prisma
  );
  return primaryRun?.project.organizationId ?? null;
}

export const action = dashboardAction(
  {
    params: ParamSchema,
    context: async (params) => {
      const organizationId = await resolveRunOrganizationId(params.runParam);
      return organizationId ? { organizationId } : {};
    },
    authorization: { action: "write", resource: { type: "runs" } },
  },
  // The PG findFirst below keeps the org-membership filter so a user can't
  // replay another org's run, and the buffered fallback verifies membership
  // via orgMember.findFirst against the snapshot's orgId.
  async ({ request, params, user }) => {
    const { runParam } = params;

    const formData = await request.formData();
    const submission = parseWithZod(formData, { schema: ReplayRunData });

    if (submission.status !== "success") {
      return json(submission.reply());
    }

    try {
      const pgRun = await runStore.findRun(
        {
          friendlyId: runParam,
          project: {
            organization: {
              members: {
                some: {
                  userId: user.id,
                },
              },
            },
          },
        },
        {
          include: {
            runtimeEnvironment: {
              select: {
                slug: true,
              },
            },
            project: {
              include: {
                organization: true,
              },
            },
          },
        },
        prisma
      );

      // Mollifier read-fallback: if the original isn't in PG yet,
      // synthesise a TaskRun from the buffered snapshot. The B4-extended
      // SyntheticRun carries every field ReplayTaskRunService reads. We
      // also need projectSlug + orgSlug + envSlug for the redirect path,
      // so look those up via the snapshot's runtimeEnvironmentId.
      let taskRun: SyntheticReplayTaskRun | null = pgRun ?? null;
      if (!taskRun) {
        const buffer = getMollifierBuffer();
        const entry = buffer ? await buffer.getEntry(runParam) : null;
        if (entry) {
          // Same org-membership gate as the PG path above. Without this
          // any authenticated user who knows a runId could replay the
          // buffered run across orgs.
          const member = await prisma.orgMember.findFirst({
            where: { userId: user.id, organizationId: entry.orgId },
            select: { id: true },
          });
          if (!member) {
            return redirectWithErrorMessage(
              submission.value.failedRedirect,
              request,
              "Run not found"
            );
          }
          const synthetic = await findRunByIdWithMollifierFallback({
            runId: runParam,
            environmentId: entry.envId,
            organizationId: entry.orgId,
          });
          if (synthetic) {
            const envRow = await prisma.runtimeEnvironment.findFirst({
              // Pin to the buffer entry's org so a malformed entry can't
              // resolve an environment in a different org.
              where: { id: entry.envId, project: { organizationId: entry.orgId } },
              select: {
                slug: true,
                project: { select: { slug: true, organization: { select: { slug: true } } } },
              },
            });
            if (envRow) {
              taskRun = buildSyntheticReplayTaskRun({ synthetic, envRow });
            }
          }
        }
      }

      if (!taskRun) {
        return redirectWithErrorMessage(submission.value.failedRedirect, request, "Run not found");
      }

      // A replay can target a different environment, but only within the source
      // run's own project. The override id is user-supplied and the downstream
      // service looks it up without scoping, so confirm it belongs to this
      // project before triggering, otherwise a run could be created in another
      // tenant's environment.
      if (submission.value.environment) {
        const overrideEnvironment = await prisma.runtimeEnvironment.findFirst({
          where: {
            id: submission.value.environment,
            project: {
              slug: taskRun.project.slug,
              organization: { slug: taskRun.project.organization.slug },
            },
          },
          select: { id: true },
        });
        if (!overrideEnvironment) {
          return redirectWithErrorMessage(
            submission.value.failedRedirect,
            request,
            "Environment not found"
          );
        }
      }

      const replayRunService = new ReplayTaskRunService();
      const newRun = await replayRunService.call(taskRun, {
        environmentId: submission.value.environment,
        payload: submission.value.payload,
        metadata: submission.value.metadata,
        tags: submission.value.tags,
        queue: submission.value.queue,
        concurrencyKey: submission.value.concurrencyKey,
        maxAttempts: submission.value.maxAttempts,
        maxDurationSeconds: submission.value.maxDurationSeconds,
        machine: submission.value.machine,
        region: submission.value.region,
        delaySeconds: submission.value.delaySeconds,
        idempotencyKey: submission.value.idempotencyKey,
        idempotencyKeyTTLSeconds: submission.value.idempotencyKeyTTLSeconds,
        ttlSeconds: submission.value.ttlSeconds,
        version: submission.value.version,
        prioritySeconds: submission.value.prioritySeconds,
        triggerSource: "dashboard",
      });

      if (!newRun) {
        return redirectWithErrorMessage(
          submission.value.failedRedirect,
          request,
          "Failed to replay run"
        );
      }

      const runPath = v3RunSpanPath(
        {
          slug: taskRun.project.organization.slug,
        },
        { slug: taskRun.project.slug },
        { slug: taskRun.runtimeEnvironment.slug },
        { friendlyId: newRun.friendlyId },
        { spanId: newRun.spanId }
      );

      logger.debug("Replayed run", {
        taskRunId: taskRun.id,
        taskRunFriendlyId: taskRun.friendlyId,
        newRunId: newRun.id,
        newRunFriendlyId: newRun.friendlyId,
        runPath,
      });

      return redirectWithSuccessMessage(runPath, request, `Replaying run`);
    } catch (error) {
      if (error instanceof Error) {
        logger.error("Failed to replay run", {
          error: {
            name: error.name,
            message: error.message,
            stack: error.stack,
          },
        });
        return redirectWithErrorMessage(submission.value.failedRedirect, request, error.message);
      }

      logger.error("Failed to replay run", { error });
      return redirectWithErrorMessage(
        submission.value.failedRedirect,
        request,
        JSON.stringify(error)
      );
    }
  }
);

async function findTask(
  environment: { type: EnvironmentType; id: string },
  taskIdentifier: string
) {
  if (environment.type === "DEVELOPMENT") {
    return $replica.backgroundWorkerTask.findFirst({
      select: {
        queueId: true,
      },
      where: {
        slug: taskIdentifier,
        runtimeEnvironmentId: environment.id,
      },
      orderBy: {
        createdAt: "desc",
      },
    });
  }

  const currentDeployment = await findCurrentWorkerDeployment({
    environmentId: environment.id,
  });
  return currentDeployment?.worker?.tasks.find((t) => t.slug === taskIdentifier);
}

async function findTaskQueue(
  environment: { type: EnvironmentType; id: string },
  taskIdentifier: string
) {
  const task = await findTask(environment, taskIdentifier);

  if (!task?.queueId) {
    return undefined;
  }

  return $replica.taskQueue.findFirst({
    where: {
      runtimeEnvironmentId: environment.id,
      id: task.queueId,
    },
    select: {
      friendlyId: true,
      name: true,
      type: true,
      paused: true,
    },
  });
}

function listLatestBackgroundWorkers(environment: { id: string }, limit = 20) {
  return $replica.backgroundWorker.findMany({
    where: {
      runtimeEnvironmentId: environment.id,
    },
    select: {
      version: true,
      engine: true,
    },
    orderBy: {
      createdAt: "desc",
    },
    take: limit,
  });
}
