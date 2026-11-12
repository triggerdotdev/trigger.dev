import { getMeter } from "@internal/tracing";
import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import {
  PrepareTrustedDeployRequest,
  SubmitTrustedDeployRequest,
  ArchiveTrustedPreviewRequest,
  PromoteTrustedDeploymentRequest,
  type SubmitTrustedDeployResponse,
  type BuildServerMetadata,
  type GitMeta,
} from "@trigger.dev/core/v3";
import { Ratelimit } from "@upstash/ratelimit";
import { createHash } from "node:crypto";
import { z } from "zod";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { authIncludeBase, toAuthenticated } from "~/models/runtimeEnvironment.server";
import { createRedisClient } from "~/redis.server";
import { isBillingConfigured } from "~/services/platform.v3.server";
import { createRedisRateLimitClient, RateLimiter } from "~/services/rateLimiterCore.server";
import { UpsertBranchService } from "~/services/upsertBranch.server";
import { extractClientIp } from "~/utils/extractClientIp.server";
import { ArchiveBranchService } from "~/services/archiveBranch.server";
import { ChangeCurrentDeploymentService } from "~/v3/services/changeCurrentDeployment.server";
import { ArtifactsService, isArtifactKeyOwnedBy } from "~/v3/services/artifacts.server";
import { InitializeDeploymentService } from "~/v3/services/initializeDeployment.server";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import { logger } from "../logger.server";
import { verifyGithubDeployToken } from "./github.server";
import { findTrustedPreviewBranch } from "./findPreviewBranch.server";
import { isTrustedDeploysEnabled } from "./featureFlag.server";
import { matchesTrustedDeploy, type GithubDeployClaims } from "./policy";

const MAX_TOKEN_LENGTH = 16_384;
const PREPARED_ARTIFACT_TTL_SECONDS = 15 * 60;
const IP_REQUESTS_PER_MINUTE = 60;
const ENVIRONMENT_REQUESTS_PER_MINUTE = 60;
const DISABLE_FAIL_OPEN_TIMEOUT = 0;

const trustedDeployRequests = getMeter("trusted-deploy").createCounter("trusted_deploy.requests", {
  description: "Trusted publishing requests by operation and HTTP status",
});

const redis = createRedisClient("trusted-deploys", {
  host: env.CACHE_REDIS_HOST,
  port: env.CACHE_REDIS_PORT,
  username: env.CACHE_REDIS_USERNAME,
  password: env.CACHE_REDIS_PASSWORD,
  tlsDisabled: env.CACHE_REDIS_TLS_DISABLED === "true",
  clusterMode: env.CACHE_REDIS_CLUSTER_MODE_ENABLED === "1",
});
const rateLimitRedis = createRedisRateLimitClient({
  host: env.RATE_LIMIT_REDIS_HOST,
  port: env.RATE_LIMIT_REDIS_PORT,
  username: env.RATE_LIMIT_REDIS_USERNAME,
  password: env.RATE_LIMIT_REDIS_PASSWORD,
  tlsDisabled: env.RATE_LIMIT_REDIS_TLS_DISABLED === "true",
  clusterMode: env.RATE_LIMIT_REDIS_CLUSTER_MODE_ENABLED === "1",
});
const ipLimiter = new RateLimiter({
  redisClient: rateLimitRedis,
  keyPrefix: "trusted-deploys:ip",
  limiter: Ratelimit.slidingWindow(IP_REQUESTS_PER_MINUTE, "1 m"),
  timeoutMs: DISABLE_FAIL_OPEN_TIMEOUT,
  ephemeralCache: false,
  logFailure: false,
});
const environmentLimiter = new RateLimiter({
  redisClient: rateLimitRedis,
  keyPrefix: "trusted-deploys:environment",
  limiter: Ratelimit.slidingWindow(ENVIRONMENT_REQUESTS_PER_MINUTE, "1 m"),
  timeoutMs: DISABLE_FAIL_OPEN_TIMEOUT,
  ephemeralCache: false,
  logFailure: false,
});
const PreparedArtifact = z.object({ binding: z.string(), environmentId: z.string() });
const environmentTypes = { staging: "STAGING", preview: "PREVIEW", prod: "PRODUCTION" } as const;
const responseHeaders = { "Cache-Control": "no-store" };

type TrustedTarget = { projectRef: string; env: keyof typeof environmentTypes };

type TrustedContext<T> = {
  request: Request;
  input: T;
  root: ReturnType<typeof toAuthenticated>;
  claims: GithubDeployClaims;
  grantId: string;
};

function trustedDeployRoute<T extends TrustedTarget>(
  operation: "prepare" | "submit" | "promote" | "archive",
  schema: z.ZodType<T>,
  handler: (context: TrustedContext<T>) => Promise<Response>,
  { requiresBuildServer = false }: { requiresBuildServer?: boolean } = {}
) {
  const action = async ({ request }: ActionFunctionArgs) => {
    if (request.method !== "POST") return failure("Method not allowed", 405);
    if (requiresBuildServer && !isBillingConfigured())
      return failure("Trusted deploys require the build server.", 503);

    try {
      const ip = extractClientIp(request.headers.get("x-forwarded-for")) ?? "unknown";
      await checkRateLimit(ipLimiter, ip);

      const token = request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
      if (!token || token.length > MAX_TOKEN_LENGTH)
        return failure("Missing or invalid GitHub token.", 401);

      let claims: GithubDeployClaims;
      try {
        claims = await verifyGithubDeployToken(token);
      } catch {
        return failure("Invalid GitHub OIDC token. Check its audience and expiry.", 401);
      }

      const body: unknown = await request.json();
      const parsed = schema.safeParse(body);
      if (!parsed.success) return failure("Invalid trusted deployment request.", 400);

      const input = parsed.data;
      const grant = await prisma.trustedDeployEnvironment.findFirst({
        where: {
          enabled: true,
          trustedDeployRepository: { project: { externalRef: input.projectRef } },
          runtimeEnvironment: {
            project: { externalRef: input.projectRef, deletedAt: null },
            organization: { deletedAt: null },
            type: environmentTypes[input.env],
            parentEnvironmentId: null,
            archivedAt: null,
          },
        },
        select: {
          id: true,
          enabled: true,
          scope: true,
          scopeValue: true,
          additionalClaims: true,
          trustedDeployRepository: true,
          runtimeEnvironment: { include: authIncludeBase },
        },
      });
      if (
        grant &&
        !(await isTrustedDeploysEnabled(grant.runtimeEnvironment.organization.featureFlags))
      ) {
        return failure("Trusted deploys are not enabled for this organization.", 403);
      }
      if (
        !grant ||
        !matchesTrustedDeploy(
          grant.trustedDeployRepository,
          {
            ...grant,
            environmentType: grant.runtimeEnvironment.type,
          },
          claims
        )
      ) {
        return failure(
          "This GitHub workflow is not trusted to deploy to the requested environment.",
          403
        );
      }

      const root = toAuthenticated(grant.runtimeEnvironment);
      await checkRateLimit(environmentLimiter, root.id);
      return await handler({ request, input, root, claims, grantId: grant.id });
    } catch (error) {
      if (error instanceof Response) return error;
      if (error instanceof SyntaxError) return failure("Invalid request body.", 400);
      if (error instanceof ServiceValidationError)
        return failure(error.message, error.status ?? 400);
      logger.error("Trusted deployment failed", {
        operation,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      return failure("Trusted deployment failed. Retry shortly.", 500);
    }
  };

  return async (args: ActionFunctionArgs) => {
    let status = 500;
    try {
      const response = await action(args);
      status = response.status;
      return response;
    } finally {
      trustedDeployRequests.add(1, { operation, status });
    }
  };
}

export const prepareAction = trustedDeployRoute(
  "prepare",
  PrepareTrustedDeployRequest,
  async ({ input, root, claims }) => {
    const binding = submissionBinding(claims, input, root.id);
    let environment = root;
    if (input.env === "preview") {
      if (!input.branch) return failure("A Preview branch is required.", 400);
      const result = await new UpsertBranchService().call(
        { type: "orgId", organizationId: root.organizationId },
        {
          projectId: root.projectId,
          env: "preview",
          branchName: input.branch,
          git: gitMetadata(claims),
        }
      );
      if (!result.success) return failure(result.error, 400);
      const branch = await prisma.runtimeEnvironment.findFirst({
        where: { id: result.branch.id, parentEnvironmentId: root.id, archivedAt: null },
        include: authIncludeBase,
      });
      if (!branch) return failure("Preview branch not found.", 404);
      environment = toAuthenticated(branch);
    }

    const artifact = await new ArtifactsService().createArtifact(
      "deployment_context",
      environment,
      input.contentLength
    );
    if (artifact.isErr()) {
      const status = artifact.error.type === "artifact_size_exceeds_limit" ? 400 : 503;
      return failure(
        "Could not prepare deployment upload. Check the archive size and retry.",
        status
      );
    }
    await redis.setex(
      artifactCacheKey(artifact.value.artifactKey),
      PREPARED_ARTIFACT_TTL_SECONDS,
      JSON.stringify({ binding, environmentId: environment.id })
    );
    return json(
      {
        ...artifact.value,
        expiresAt: artifact.value.expiresAt.toISOString(),
      },
      { headers: responseHeaders }
    );
  },
  { requiresBuildServer: true }
);

export const submitAction = trustedDeployRoute(
  "submit",
  SubmitTrustedDeployRequest,
  async ({ request, input, root, claims, grantId }) => {
    const binding = submissionBinding(claims, input, root.id);
    const stored = await redis.get(artifactCacheKey(input.artifactKey));
    const prepared = PreparedArtifact.safeParse(stored ? JSON.parse(stored) : null);
    if (!prepared.success || prepared.data.binding !== binding) {
      return failure(
        "The prepared upload expired or belongs to a different workflow or target.",
        403
      );
    }
    const environmentRow = await prisma.runtimeEnvironment.findFirst({
      where: {
        id: prepared.data.environmentId,
        projectId: root.projectId,
        type: root.type,
        parentEnvironmentId: input.env === "preview" ? root.id : null,
        archivedAt: null,
      },
      include: authIncludeBase,
    });
    if (!environmentRow || (input.env !== "preview" && environmentRow.id !== root.id)) {
      return failure("Deployment environment not found.", 404);
    }
    const environment = toAuthenticated(environmentRow);
    if (
      !input.artifactKey.startsWith("deployments/") ||
      !isArtifactKeyOwnedBy(environment, input.artifactKey)
    ) {
      return failure("Invalid source archive.", 403);
    }

    const identity: NonNullable<BuildServerMetadata["trustedDeploy"]> = {
      grantId,
      issuer: claims.iss,
      subject: claims.sub,
      repository: claims.repository,
      repositoryId: claims.repository_id,
      repositoryOwnerId: claims.repository_owner_id,
      runId: claims.run_id,
      runAttempt: claims.run_attempt,
      workflowRef: claims.job_workflow_ref ?? claims.workflow_ref,
    };
    const result = await new InitializeDeploymentService().call(
      environment,
      {
        contentHash: "-",
        type: "MANAGED",
        isNativeBuild: true,
        runtime: input.runtime,
        artifactKey: input.artifactKey,
        configFilePath: input.configFilePath,
        skipPromotion: input.skipPromotion,
        gitMeta: gitMetadata(claims),
        triggeredVia: "cli:github_actions",
        externalId: input.externalId,
        force: input.force,
      },
      {
        cliVersion: request.headers.get("x-trigger-cli-version")?.slice(0, 128),
        trustedDeploy: identity,
      }
    );

    const { deployment } = result;
    const response = {
      id: deployment.friendlyId,
      contentHash: deployment.contentHash,
      shortCode: deployment.shortCode,
      version: deployment.version,
      imageTag: result.imageRef,
      imagePlatform: deployment.imagePlatform,
      externalId: deployment.externalId ?? undefined,
      outcome: result.outcome,
      ...(result.outcome === "created"
        ? { eventStream: result.eventStream, canceledDeployments: result.canceledDeployments }
        : { isPromoted: result.isPromoted }),
    } satisfies SubmitTrustedDeployResponse;
    logger.info("Trusted deployment submitted", { deploymentId: deployment.id, ...identity });
    return json(response, { headers: responseHeaders });
  },
  { requiresBuildServer: true }
);

export const archiveAction = trustedDeployRoute(
  "archive",
  ArchiveTrustedPreviewRequest,
  async ({ input, root, claims }) => {
    const environment = await findTrustedPreviewBranch(prisma, root, input.branch);
    if (environment) {
      const result = await new ArchiveBranchService().call(
        { type: "orgId", organizationId: root.organizationId },
        { environmentId: environment.id }
      );
      if (!result.success) return failure(result.error, 400);
    }
    logger.info(
      environment ? "Trusted Preview branch archived" : "Trusted Preview branch already absent",
      {
        projectId: root.projectId,
        branch: input.branch,
        repository: claims.repository,
        runId: claims.run_id,
      }
    );
    return json({ success: true }, { headers: responseHeaders });
  }
);

export const promoteAction = trustedDeployRoute(
  "promote",
  PromoteTrustedDeploymentRequest,
  async ({ input, root, claims }) => {
    let environment: { id: string } | null = root;
    if (input.env === "preview") {
      if (!input.branch) return failure("A Preview branch is required.", 400);
      environment = await findTrustedPreviewBranch(prisma, root, input.branch);
    }
    if (!environment) return failure("Preview branch not found.", 404);
    const deployment = await prisma.workerDeployment.findFirst({
      where: { environmentId: environment.id, version: input.version },
    });
    if (!deployment) return failure("Deployment not found.", 404);
    await new ChangeCurrentDeploymentService().call(deployment, "promote");
    logger.info("Trusted deployment promoted", {
      deploymentId: deployment.id,
      repository: claims.repository,
      runId: claims.run_id,
    });
    return json(
      { id: deployment.friendlyId, version: deployment.version, shortCode: deployment.shortCode },
      { headers: responseHeaders }
    );
  }
);

function failure(error: string, status: number) {
  return json({ error }, { status, headers: responseHeaders });
}

async function checkRateLimit(limiter: RateLimiter, key: string) {
  const result = await limiter.limit(key);
  if (!result.success) {
    throw json(
      { error: "Trusted deployment rate limit exceeded." },
      {
        status: 429,
        headers: {
          ...responseHeaders,
          "Retry-After": String(Math.max(1, Math.ceil((result.reset - Date.now()) / 1000))),
        },
      }
    );
  }
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function artifactCacheKey(key: string) {
  return `trusted-deploy:artifact:${hash(key)}`;
}

function submissionBinding(
  claims: GithubDeployClaims,
  target: { projectRef: string; env: string; branch?: string },
  rootId: string
) {
  return hash(
    JSON.stringify([
      claims.iss,
      claims.sub,
      claims.repository_id,
      claims.repository_owner_id,
      claims.run_id,
      claims.run_attempt,
      claims.workflow_ref,
      claims.job_workflow_ref,
      rootId,
      target.projectRef,
      target.env,
      target.branch,
    ])
  );
}

function gitMetadata(claims: GithubDeployClaims): GitMeta {
  return {
    provider: "github",
    source: "github_actions",
    remoteUrl: `https://github.com/${claims.repository}`,
    commitSha: claims.sha,
    commitRef: claims.ref.replace(/^refs\/(heads|tags|pull)\//, ""),
  };
}
