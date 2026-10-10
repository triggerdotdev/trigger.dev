import {
  InitializeDeploymentRequestBody,
  normalizeExternalDeploymentId,
} from "@trigger.dev/core/v3";
import { type Prisma, type WorkerDeploymentStatus } from "@trigger.dev/database";
import { errAsync, fromPromise, okAsync, type ResultAsync } from "neverthrow";
import { type PrismaClient, prisma } from "~/db.server";
import { env } from "~/env.server";
import { findEnvironmentById } from "~/models/runtimeEnvironment.server";
import { type AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { type EnqueueBuildError } from "~/services/enqueueGithubBuild.server";
import { logger } from "~/services/logger.server";
import { enqueueBuild, enqueueGithubBuild } from "~/services/platform.v3.server";
import { BuildSettingsSchema } from "../buildSettings";
import { type RedeploySource, resolveRedeploySource } from "../redeploy";
import { atomicProductionDeploymentUrl } from "./atomicProductionDeployment.server";
import { ServiceValidationError } from "./baseService.server";
import { DeploymentService } from "./deployment.server";
import { FINAL_DEPLOYMENT_STATUSES } from "./failDeployment.server";
import {
  InitializeDeploymentService,
  type InitializeDeploymentResult,
} from "./initializeDeployment.server";

const NON_TERMINAL_DEPLOYMENT_STATUSES: WorkerDeploymentStatus[] = [
  "PENDING",
  "INSTALLING",
  "BUILDING",
  "DEPLOYING",
];

const sourceSelect = {
  id: true,
  status: true,
  triggeredVia: true,
  environmentId: true,
  createdAt: true,
  git: true,
  buildServerMetadata: true,
  project: { select: { buildSettings: true } },
  environment: { select: { archivedAt: true } },
} satisfies Prisma.WorkerDeploymentSelect;

type SourceDeployment = Prisma.WorkerDeploymentGetPayload<{ select: typeof sourceSelect }>;

export type RedeployDeploymentError =
  | { type: "deployment_not_found" }
  | { type: "deployment_not_redeployable" }
  | { type: "deployment_expired" }
  | { type: "deployment_in_flight" }
  | { type: "atomic_production"; vercelUrl: string }
  | { type: "failed_to_enqueue_build"; message: string }
  | { type: "other"; cause: unknown };

type RedeployDeploymentDeps = {
  prisma: PrismaClient;
  windowDays: number;
  now: () => Date;
  findEnvironment: typeof findEnvironmentById;
  atomicProductionUrl: typeof atomicProductionDeploymentUrl;
  initialize: (
    environment: AuthenticatedEnvironment,
    payload: InitializeDeploymentRequestBody,
    options: { redeployOf: string }
  ) => Promise<InitializeDeploymentResult>;
  enqueueGithub: typeof enqueueGithubBuild;
  enqueueArtifact: (
    projectId: string,
    deploymentId: string,
    artifactKey: string,
    options: { configFilePath?: string; skipPromotion?: boolean }
  ) => ResultAsync<{ buildId: string }, EnqueueBuildError>;
  cancel: (environmentId: string, friendlyId: string, canceledReason: string) => Promise<void>;
};

const defaultDeps: RedeployDeploymentDeps = {
  prisma,
  windowDays: env.DEPLOYMENTS_REDEPLOY_WINDOW_DAYS,
  now: () => new Date(),
  findEnvironment: findEnvironmentById,
  atomicProductionUrl: atomicProductionDeploymentUrl,
  initialize: (environment, payload, options) =>
    new InitializeDeploymentService().call(environment, payload, options),
  enqueueGithub: enqueueGithubBuild,
  enqueueArtifact: (projectId, deploymentId, artifactKey, options) =>
    fromPromise(
      enqueueBuild(projectId, deploymentId, artifactKey, { ...options, fromBundle: false }),
      () => ({ type: "build_service_unreachable" as const })
    ).andThen((result) =>
      result
        ? okAsync({ buildId: result.buildId })
        : errAsync({ type: "billing_not_configured" as const })
    ),
  cancel: async (environmentId, friendlyId, canceledReason) => {
    const result = await new DeploymentService().cancelDeployment(
      { id: environmentId },
      friendlyId,
      {
        canceledReason,
      }
    );
    if (result.isErr()) {
      throw new Error(`Failed to cancel deployment ${friendlyId}: ${result.error.type}`);
    }
  },
};

// Lowercase-leading so it reads after "Failed to queue the build: "; the toast upper-cases it.
function enqueueFailureDetail(failure: EnqueueBuildError): string {
  if (failure.type === "billing_not_configured") return "billing is not configured";
  if (failure.type === "build_service_unreachable") return "the build service could not be reached";
  const { code, error } = failure;
  switch (code) {
    case "COMMIT_NOT_FOUND":
      return "the commit no longer exists in the connected repository";
    case "NO_CONNECTED_REPOSITORY":
      return "the project has no connected GitHub repository";
    case "GITHUB_UNAVAILABLE":
      return "GitHub could not be reached, try again shortly";
    case "ATOMIC_PRODUCTION_REQUIRES_VERCEL":
      return "this environment is deployed together with Vercel, deploy it from Vercel";
    case "DEPLOYMENT_NOT_PENDING":
      return "another deployment of this commit was just started";
    default:
      return error.charAt(0).toLowerCase() + error.slice(1);
  }
}

function sentence(detail: string): string {
  return detail.charAt(0).toUpperCase() + detail.slice(1);
}

export class RedeployDeploymentService {
  #deps: RedeployDeploymentDeps;

  constructor(deps: Partial<RedeployDeploymentDeps> = {}) {
    this.#deps = { ...defaultDeps, ...deps };
  }

  public call(opts: {
    userId: string;
    projectId: string;
    deploymentShortCode: string;
    skipPromotion?: boolean;
  }): ResultAsync<{ version: string; shortCode: string }, RedeployDeploymentError> {
    const {
      prisma,
      windowDays,
      now,
      findEnvironment,
      atomicProductionUrl,
      initialize,
      enqueueGithub,
      enqueueArtifact,
      cancel,
    } = this.#deps;
    const skipPromotion = opts.skipPromotion ?? false;

    const other = (cause: unknown) => ({ type: "other" as const, cause });

    const findSource = () =>
      fromPromise(
        prisma.workerDeployment.findFirst({
          where: { projectId: opts.projectId, shortCode: opts.deploymentShortCode },
          select: sourceSelect,
        }),
        other
      ).andThen((source) => {
        if (!source) return errAsync({ type: "deployment_not_found" as const });
        if (!FINAL_DEPLOYMENT_STATUSES.includes(source.status)) {
          return errAsync({ type: "deployment_not_redeployable" as const });
        }
        if (source.createdAt.getTime() < now().getTime() - windowDays * 24 * 60 * 60 * 1000) {
          return errAsync({ type: "deployment_expired" as const });
        }
        const redeploySource = resolveRedeploySource(source);
        // An archived preview branch can no longer take deployments.
        if (!redeploySource || source.environment.archivedAt) {
          return errAsync({ type: "deployment_not_redeployable" as const });
        }
        return okAsync({ source, redeploySource });
      });

    const loadEnvironment = <T extends { source: SourceDeployment }>(context: T) =>
      fromPromise(findEnvironment(context.source.environmentId), other).andThen((environment) =>
        environment
          ? okAsync({ ...context, environment })
          : errAsync({ type: "deployment_not_found" as const })
      );

    const rejectAtomicProduction = <T extends { environment: AuthenticatedEnvironment }>(
      context: T
    ) =>
      fromPromise(
        atomicProductionUrl(opts.projectId, context.environment.type, prisma),
        other
      ).andThen((vercelUrl) =>
        vercelUrl ? errAsync({ type: "atomic_production" as const, vercelUrl }) : okAsync(context)
      );

    // The build server serializes builds per environment; this only keeps the UI from queueing more.
    const rejectInFlight = <T extends { source: SourceDeployment }>(context: T) =>
      fromPromise(
        prisma.workerDeployment.findFirst({
          where: {
            environmentId: context.source.environmentId,
            // oxlint-disable-next-line trigger-prisma/no-unbounded-list-filter -- Fixed four deployment statuses; the bind-parameter count cannot grow with input.
            status: { in: NON_TERMINAL_DEPLOYMENT_STATUSES },
          },
          select: { id: true },
        }),
        other
      ).andThen((inFlight) =>
        inFlight ? errAsync({ type: "deployment_in_flight" as const }) : okAsync(context)
      );

    const createDeployment = <
      T extends {
        source: SourceDeployment;
        redeploySource: RedeploySource;
        environment: AuthenticatedEnvironment;
      },
    >(
      context: T
    ) => {
      const { source, redeploySource, environment } = context;
      const buildSettings = BuildSettingsSchema.safeParse(source.project.buildSettings);
      const common = {
        contentHash: "NOT_AVAILABLE",
        type: "MANAGED",
        initialStatus: "PENDING",
        userId: opts.userId,
        skipPromotion,
        // The platform enqueue-build call below is the only enqueue for a redeploy.
        skipEnqueue: true,
      } as const;

      const payload = (force?: boolean) =>
        InitializeDeploymentRequestBody.parse(
          redeploySource.kind === "github"
            ? {
                ...common,
                gitMeta: redeploySource.git,
                isNativeBuild: !(
                  buildSettings.success && buildSettings.data.disableNativeBuildServer
                ),
                triggeredVia: "git_integration:github",
                externalId: normalizeExternalDeploymentId(redeploySource.commitSha),
                ...(force ? { force } : {}),
              }
            : {
                ...common,
                gitMeta: redeploySource.git,
                isNativeBuild: true,
                artifactKey: redeploySource.artifactKey,
                configFilePath: redeploySource.configFilePath,
                triggeredVia: "dashboard",
              }
        );

      const initializeOnce = (force?: boolean) =>
        fromPromise(
          initialize(environment, payload(force), { redeployOf: opts.deploymentShortCode }),
          (error) =>
            error instanceof ServiceValidationError && error.status === 409
              ? { type: "deployment_in_flight" as const }
              : other(error)
        );

      return initializeOnce()
        .andThen((initialized) =>
          // A DEPLOYED commit short-circuits external id reuse; redeploying it is an explicit ask
          // to rebuild, so force past that. Nothing is in flight here, so no build gets cancelled.
          initialized.outcome === "existing" ? initializeOnce(true) : okAsync(initialized)
        )
        .andThen((initialized) =>
          initialized.outcome === "existing"
            ? errAsync(
                other(new Error("Deployment still reported as existing after a forced initialize"))
              )
            : okAsync({ ...context, deployment: initialized.deployment })
        );
    };

    const enqueue = <
      T extends {
        source: SourceDeployment;
        redeploySource: RedeploySource;
        environment: AuthenticatedEnvironment;
        deployment: { id: string; friendlyId: string; version: string; shortCode: string };
      },
    >(
      context: T
    ) => {
      const { source, redeploySource, environment, deployment } = context;
      const enqueued =
        redeploySource.kind === "github"
          ? enqueueGithub(
              opts.projectId,
              deployment.friendlyId,
              { commitSha: redeploySource.commitSha, ref: redeploySource.commitRef },
              { skipPromotion }
            )
          : enqueueArtifact(opts.projectId, deployment.friendlyId, redeploySource.artifactKey, {
              configFilePath: redeploySource.configFilePath,
              skipPromotion,
            });

      return enqueued
        .map((result) => ({ ...context, buildId: result.buildId }))
        .orElse((failure) => {
          const detail = enqueueFailureDetail(failure);
          logger.warn("Failed to enqueue redeploy build", {
            projectId: opts.projectId,
            deploymentId: deployment.id,
            sourceDeploymentId: source.id,
            source: redeploySource.kind,
            failure,
          });
          return fromPromise(
            cancel(environment.id, deployment.friendlyId, `Failed to queue the build: ${detail}`),
            (cancelError) => cancelError
          )
            .orElse((cancelError) => {
              logger.error("Failed to cancel deployment after failed redeploy enqueue", {
                projectId: opts.projectId,
                deploymentId: deployment.id,
                error: cancelError,
              });
              return okAsync(undefined);
            })
            .andThen(() =>
              errAsync({ type: "failed_to_enqueue_build" as const, message: sentence(detail) })
            );
        });
    };

    return findSource()
      .andThen(loadEnvironment)
      .andThen(rejectAtomicProduction)
      .andThen(rejectInFlight)
      .andThen(createDeployment)
      .andThen(enqueue)
      .andTee(({ source, redeploySource, deployment, buildId }) =>
        logger.info("Queued redeploy", {
          projectId: opts.projectId,
          deploymentId: deployment.id,
          sourceDeploymentId: source.id,
          source: redeploySource.kind,
          buildId,
        })
      )
      .map(({ deployment }) => ({ version: deployment.version, shortCode: deployment.shortCode }));
  }
}
