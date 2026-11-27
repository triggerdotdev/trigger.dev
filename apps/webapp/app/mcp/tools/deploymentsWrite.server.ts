import { createHmac } from "node:crypto";
import { sanitizeBranchName } from "@trigger.dev/core/v3/utils/gitBranch";
import { CURRENT_DEPLOYMENT_LABEL } from "@trigger.dev/core/v3/isomorphic";
import type {
  RuntimeEnvironmentType,
  WorkerDeployment,
  WorkerDeploymentStatus,
} from "@trigger.dev/database";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { StoredEnvironmentValueSchema } from "~/services/environmentEncryption/crypto.server";
import { resolveRedeploySource } from "~/v3/redeploy";
import { atomicProductionDeploymentUrl } from "~/v3/services/atomicProductionDeployment.server";
import { FINAL_DEPLOYMENT_STATUSES } from "~/v3/services/failDeployment.server";
import { RedeployDeploymentService } from "~/v3/services/redeployDeployment.server";
import { getSkewProtectionThresholdsForRollback } from "~/presenters/v3/SkewProtectionThresholdPresenter.server";
import type { SkewProtectionThresholdsCleared } from "~/v3/services/skewProtectionThreshold.server";
import { isBranchableEnvironment } from "~/utils/branchableEnvironment";
import { ServiceValidationError } from "~/v3/services/common.server";
import { compareDeploymentVersions } from "~/v3/utils/deploymentVersions";
import { defaultFingerprintKey } from "../confirm/confirmation.server";
import type { McpSubject } from "../gate/types";
import type { McpToolDefinition } from "../registry.server";
import { fenceUntrusted } from "../gate/fence.server";
import { textResult } from "./define.server";
import { defineWriteTool, staleAnswer, staleApproval } from "./defineWrite.server";
import { deploymentNotFoundText } from "./format/deployments";
import {
  agentFence,
  describeDeploymentForAgent,
  describeDeploymentForPreview,
  environmentLabelForAgent,
  environmentLabelForPreview,
  previewQuote,
} from "./format/environments";
import { plainError } from "./format/insights";
import { previewBranchRefusal, resolvePreviewBranchSubject } from "./previewBranch.server";
import {
  DeploymentWriteInput,
  DeployTrackedBranchInput,
  RedeployInput,
} from "./schemas/environments";
import { cardVerificationDeployRefusal } from "~/v3/cardVerificationDeployGate.server";
import { checkDeployAccess } from "~/v3/deploymentAccess.server";
import type { CardVerificationGate } from "~/v3/cardVerificationGate.server";
import type { DeploymentAccessController } from "@trigger.dev/plugins";
import { BranchTrackingConfigSchema, getTrackedBranchForEnvironment } from "~/v3/github";
import { deploymentOnboardingEnabled } from "~/v3/services/deploymentOnboardingEnabled.server";
import {
  type DeployNowResult,
  TriggerDeployNowService,
} from "~/v3/services/triggerDeployNow.server";

type Direction = "promote" | "rollback";
type DeploymentArgs = { shortCode: string };
type CancelOutcome = "canceled" | "final" | "not_found";

const IS_FINAL: Record<WorkerDeploymentStatus, boolean> = {
  PENDING: false,
  INSTALLING: false,
  BUILDING: false,
  DEPLOYING: false,
  DEPLOYED: true,
  FAILED: true,
  CANCELED: true,
  TIMED_OUT: true,
};

const auth = { action: "write", subject: "deployments" } as const;

export const PREVIEW_PARENT =
  "Deployments in preview belong to preview branches. Pass branch with the preview branch name (list_branches with environment preview lists them); nothing changed.";

async function cancelOutcome(environmentId: string, friendlyId: string): Promise<CancelOutcome> {
  const { DeploymentService } = await import("~/v3/services/deployment.server");
  const result = await new DeploymentService().cancelDeployment({ id: environmentId }, friendlyId);
  if (result.isOk()) return "canceled";
  switch (result.error.type) {
    case "failed_to_delete_deployment_timeout":
      return "canceled";
    case "deployment_cannot_be_cancelled":
      return "final";
    case "deployment_not_found":
      return "not_found";
    default:
      throw new Error(`cancel_deployment: ${result.error.type}`);
  }
}

const environmentSelect = {
  id: true,
  type: true,
  branchName: true,
  parentEnvironmentId: true,
  isBranchableEnvironment: true,
  organization: { select: { featureFlags: true } },
} as const;

type Located = {
  environment: {
    id: string;
    type: string;
    branchName: string | null;
    organization: { featureFlags: unknown };
  };
  deployment: WorkerDeployment;
};

async function locate(
  args: DeploymentArgs,
  subject: McpSubject | null,
  // Set by tools whose gate falls back to the preview parent for an unresolved branch.
  fallbackBranch?: string
): Promise<Located | { refuse: string }> {
  if (!subject?.environmentId || !subject.projectId)
    return { refuse: deploymentNotFoundText(args.shortCode) };
  const environment = await prisma.runtimeEnvironment.findFirst({
    where: { id: subject.environmentId, projectId: subject.projectId },
    select: environmentSelect,
  });
  if (!environment) return { refuse: deploymentNotFoundText(args.shortCode) };
  const branchRefusal = await previewBranchRefusal(environment, fallbackBranch);
  if (branchRefusal) return { refuse: branchRefusal };
  if (isBranchableEnvironment(environment)) return { refuse: PREVIEW_PARENT };

  const deployment = await prisma.workerDeployment.findFirst({
    where: { environmentId: environment.id, shortCode: args.shortCode },
  });
  if (!deployment) return { refuse: deploymentNotFoundText(args.shortCode) };
  return { environment, deployment };
}

function clearedText(
  cleared:
    | { environment?: { version: string }; tasks: Array<{ task: string; version: string }> }
    | undefined
): string {
  if (!cleared) return "";
  const parts = [
    ...(cleared.environment
      ? [
          `the environment's threshold ${agentFence(cleared.environment.version, "deployment-version")}`,
        ]
      : []),
    ...cleared.tasks.map(
      ({ task, version }) =>
        `task ${agentFence(task, "task-id")} at ${agentFence(version, "deployment-version")}`
    ),
  ];
  return parts.length ? ` Removed skew protection thresholds: ${parts.join(", ")}.` : "";
}

/** A keyed digest of the thresholds a switch clears, so quoted ids clipped alike still bind the approval. */
const thresholdsFingerprint = (
  key: string,
  projectId: string,
  clearing: SkewProtectionThresholdsCleared
) =>
  createHmac("sha256", key)
    .update(
      JSON.stringify([
        projectId,
        "thresholds",
        clearing.environment?.version ?? null,
        [...clearing.tasks]
          .sort((a, b) => a.task.localeCompare(b.task))
          .map(({ task, version }) => [task, version]),
      ])
    )
    .digest("hex")
    .slice(0, 12);

type ChangePlan = Located & {
  preview: string;
  currentId: string | null;
  replaced: { version: string; shortCode: string } | null;
  clearing: SkewProtectionThresholdsCleared;
};

async function planChange(
  direction: Direction,
  args: DeploymentArgs,
  subject: McpSubject | null,
  fingerprintKey: string
): Promise<ChangePlan | { refuse: string }> {
  const located = await locate(args, subject);
  if ("refuse" in located) return located;
  const { deployment, environment } = located;
  const verb = direction === "promote" ? "promoted" : "rolled back";
  const target = describeDeploymentForAgent(deployment);

  if (deployment.status !== "DEPLOYED") {
    return {
      refuse: `Deployment ${target} is ${deployment.status} and cannot be ${verb}: only a DEPLOYED deployment can be; nothing changed.`,
    };
  }
  if (!deployment.workerId) {
    return {
      refuse: `Deployment ${target} is not associated with a worker and cannot be ${verb}; nothing changed.`,
    };
  }
  const { blockedForComputeOnly } = await import("~/v3/services/changeCurrentDeployment.server");
  if (blockedForComputeOnly(deployment, environment.organization.featureFlags)) {
    return {
      refuse: `Deployment ${target} has no compute template, and this organization's runs only run on compute, so it cannot be ${verb}. Deploy a new version instead; nothing changed.`,
    };
  }

  const current = await prisma.workerDeploymentPromotion.findFirst({
    where: { environmentId: environment.id, label: CURRENT_DEPLOYMENT_LABEL },
    select: { deployment: { select: { id: true, version: true, shortCode: true, git: true } } },
  });

  if (current?.deployment.id === deployment.id) {
    return { refuse: `Deployment ${target} is already the current deployment; nothing changed.` };
  }
  if (current) {
    const order = compareDeploymentVersions(current.deployment.version, deployment.version);
    if (direction === "promote" && order >= 0) {
      return {
        refuse: `Deployment ${target} is older than the current deployment, so it cannot be promoted. Use rollback_deployment to make an older deployment current; nothing changed.`,
      };
    }
    if (direction === "rollback" && order <= 0) {
      return {
        refuse: `Deployment ${target} is newer than the current deployment, so it cannot be rolled back to. Use promote_deployment to make a newer deployment current; nothing changed.`,
      };
    }
  }

  // The switch clears every skew protection threshold above the new current version.
  const thresholds = await getSkewProtectionThresholdsForRollback(prisma, environment.id);
  const above = (version: string) => compareDeploymentVersions(deployment.version, version) < 0;
  const clearing = {
    environment:
      thresholds.thresholdVersion && above(thresholds.thresholdVersion)
        ? { version: thresholds.thresholdVersion }
        : undefined,
    tasks: thresholds.taskThresholds.filter(({ version }) => above(version)),
  };
  const removed = [
    ...(clearing.environment
      ? [`the environment's threshold ${previewQuote(clearing.environment.version)}`]
      : []),
    ...clearing.tasks.map(
      ({ task, version }) => `task ${previewQuote(task)} at ${previewQuote(version)}`
    ),
  ];

  const replaced = current ? describeDeploymentForPreview(current.deployment) : undefined;
  const subjectLine = describeDeploymentForPreview(deployment);
  const undo = direction === "promote" ? "rollback_deployment" : "promote_deployment";
  const preview = [
    `${direction === "promote" ? "Promote" : "Roll back to"} deployment ${subjectLine}: it becomes the current deployment of ${environmentLabelForPreview(environment)}.`,
    replaced
      ? `It replaces the current deployment ${replaced}.`
      : "The environment has no current deployment now.",
    "From now on, new runs and queued runs not locked to a version run on this version; runs that already started keep the version they started on.",
    "Tasks that are triggered but not included in this version stay queued until a deployment that includes them is made current.",
    "Schedules declared in code are synced to this version: the ones it declares are created or updated, and declared schedules it no longer has are removed. Schedules created in the dashboard or with the SDK are not changed. Webhook endpoints declared in code are synced the same way.",
    ...(removed.length
      ? [
          `It removes the skew protection thresholds above this version: ${removed.join(", ")} (set ${thresholdsFingerprint(fingerprintKey, subject!.projectId!, clearing)}).`,
        ]
      : []),
    replaced
      ? `To undo, make the replaced deployment current again with ${undo}${removed.length ? "; that does not restore the removed skew protection thresholds" : ""}.`
      : "There is no previous current deployment to return to.",
  ].join(" ");

  return {
    ...located,
    preview,
    currentId: current?.deployment.id ?? null,
    replaced: current?.deployment ?? null,
    clearing,
  };
}

async function planCancel(
  args: DeploymentArgs,
  subject: McpSubject | null
): Promise<(Located & { preview: string }) | { refuse: string }> {
  const located = await locate(args, subject);
  if ("refuse" in located) return located;
  const { deployment, environment } = located;
  const target = describeDeploymentForAgent(deployment);
  if (IS_FINAL[deployment.status]) {
    return {
      refuse: `Deployment ${target} is already ${deployment.status} and cannot be canceled; nothing changed.`,
    };
  }
  return {
    ...located,
    preview: [
      `Cancel deployment ${describeDeploymentForPreview(deployment)} in ${environmentLabelForPreview(environment)}.`,
      "It is marked canceled and is never finalized, so it never becomes the current deployment.",
      "Canceling cannot be undone; start a new deployment instead.",
      "The current deployment and existing runs are not changed.",
    ].join(" "),
  };
}

function changeTool(direction: Direction, fingerprintKey: () => Promise<string>) {
  const promote = direction === "promote";
  return defineWriteTool({
    name: promote ? "promote_deployment" : "rollback_deployment",
    title: promote ? "Promote Deployment" : "Rollback Deployment",
    description: promote
      ? "Make a newer deployed version the current deployment of an environment, like Promote on the Deployments page. New runs use it from then on. Identify it by its short code from list_deploys; for preview pass the branch."
      : "Make an older deployed version the current deployment of an environment again, like Rollback on the Deployments page. New runs use it from then on. Identify it by its short code from list_deploys; for preview pass the branch.",
    shape: DeploymentWriteInput.shape,
    approval: "configurable",
    auth,
    confirm: {
      preview: async (args, subject) => {
        const plan = await planChange(direction, args, subject, await fingerprintKey());
        return "refuse" in plan ? plan : plan.preview;
      },
    },
    run: async (input, ctx) => {
      const plan = await planChange(direction, input, ctx.subject, await fingerprintKey());
      if ("refuse" in plan) return plainError(plan.refuse);
      const stale = staleApproval(ctx, plan.preview, plainError);
      if (stale) return stale;

      try {
        const { ChangeCurrentDeploymentService } =
          await import("~/v3/services/changeCurrentDeployment.server");
        const result = await new ChangeCurrentDeploymentService().call(plan.deployment, direction, {
          actor: { userId: ctx.identity.userId },
          expectedCurrentDeploymentId: plan.currentId,
          expectedClearedThresholds: plan.clearing,
        });
        if (result.stale) return staleAnswer(plainError);
        return textResult(
          `${describeDeploymentForAgent(plan.deployment)} is now the current deployment of ${environmentLabelForAgent(plan.environment)}${plan.replaced ? `, replacing ${describeDeploymentForAgent({ ...plan.replaced, git: null })}` : ""}.${clearedText(result.skewProtectionThresholdsCleared)}`
        );
      } catch (error) {
        if (error instanceof ServiceValidationError) {
          return plainError(fenceUntrusted(error.message, "deployment-error"));
        }
        throw error;
      }
    },
  });
}

const IN_PROGRESS: WorkerDeploymentStatus[] = ["PENDING", "INSTALLING", "BUILDING", "DEPLOYING"];

type Redeploy = RedeployDeploymentService["call"];
const defaultRedeploy: Redeploy = (opts) => new RedeployDeploymentService().call(opts);

type RedeployArgs = DeploymentArgs & { promote?: boolean; branch?: string };

async function planRedeploy(
  args: RedeployArgs,
  subject: McpSubject | null,
  now = new Date()
): Promise<(Located & { preview: string }) | { refuse: string }> {
  const located = await locate(args, subject, args.branch);
  if ("refuse" in located) return located;
  const { deployment, environment } = located;
  const target = describeDeploymentForAgent(deployment);

  if (!FINAL_DEPLOYMENT_STATUSES.includes(deployment.status)) {
    return {
      refuse: `Deployment ${target} is ${deployment.status} and cannot be redeployed until it finishes; nothing changed.`,
    };
  }
  const windowDays = env.DEPLOYMENTS_REDEPLOY_WINDOW_DAYS;
  if (deployment.createdAt.getTime() < now.getTime() - windowDays * 86_400_000) {
    return {
      refuse: `Deployment ${target} is older than ${windowDays} days and cannot be redeployed. Deploy a new version instead; nothing changed.`,
    };
  }
  const source = resolveRedeploySource({
    ...deployment,
    hasBuildEnvVars: StoredEnvironmentValueSchema.safeParse(deployment.buildEnvVars).success,
  });
  if (!source) {
    return {
      refuse: `Deployment ${target} has no stored source to rebuild from, so it cannot be redeployed; nothing changed.`,
    };
  }
  const vercelUrl = await atomicProductionDeploymentUrl(
    subject!.projectId!,
    environment.type as RuntimeEnvironmentType,
    prisma
  );
  if (vercelUrl) {
    return {
      refuse:
        "This environment is deployed together with Vercel. Deploy it from Vercel; nothing changed.",
    };
  }
  const inFlight = await prisma.workerDeployment.findFirst({
    // oxlint-disable-next-line trigger-prisma/no-unbounded-list-filter -- Fixed four deployment statuses.
    where: { environmentId: environment.id, status: { in: IN_PROGRESS } },
    select: { version: true, shortCode: true, status: true },
  });
  if (inFlight) {
    return {
      refuse: `Deployment ${describeDeploymentForAgent({ ...inFlight, git: null })} is still ${inFlight.status} in this environment. Wait for it to finish or cancel it with cancel_deployment; nothing changed.`,
    };
  }

  const current = await prisma.workerDeploymentPromotion.findFirst({
    where: { environmentId: environment.id, label: CURRENT_DEPLOYMENT_LABEL },
    select: { deployment: { select: { version: true, shortCode: true, git: true } } },
  });
  const promote = args.promote ?? true;
  const from =
    source.kind === "github"
      ? `git commit ${previewQuote(source.commitSha)} on branch ${previewQuote(source.commitRef)}`
      : source.fromBundle
        ? "the bundle uploaded for it, with the build-time environment variables it was deployed with"
        : "the source files uploaded for it";
  const replaced = current ? describeDeploymentForPreview(current.deployment) : undefined;
  const preview = [
    `Redeploy deployment ${describeDeploymentForPreview(deployment)} in ${environmentLabelForPreview(environment)}: a new deployment is created and built from ${from}.`,
    "It starts a new build, which uses build time, and runs in the background.",
    promote
      ? `The new deployment becomes current if its build succeeds and nothing newer is current by then${replaced ? `, replacing ${replaced}` : ""}.`
      : `When the build finishes the new deployment is not made current${replaced ? `; ${replaced} stays current` : ""}. Promote it later with promote_deployment.`,
  ].join(" ");
  return { ...located, preview };
}

function redeployRefusal(
  error: {
    type: string;
    message?: string;
    deployment?: { version: string; shortCode: string };
    cancelled?: boolean;
  },
  target: string
): string {
  switch (error.type) {
    case "deployment_in_flight":
      return "Another deployment is already in progress in this environment. Wait for it to finish or cancel it with cancel_deployment; nothing changed.";
    case "atomic_production":
      return "This environment is deployed together with Vercel. Deploy it from Vercel; nothing changed.";
    case "deployment_not_redeployable":
      return `Deployment ${target} cannot be redeployed; nothing changed.`;
    case "deployment_expired":
      return `Deployment ${target} is too old to be redeployed; nothing changed.`;
    case "failed_to_enqueue_build": {
      const created = error.deployment
        ? describeDeploymentForAgent({ ...error.deployment, git: null })
        : "";
      const reason = fenceUntrusted(error.message ?? "", "build-error");
      return error.cancelled
        ? `A new deployment ${created} was created and then cancelled because its build could not be queued: ${reason}`
        : `A new deployment ${created} was created but its build could not be queued and it could not be cancelled: ${reason}; check it with get_deployment_details.`;
    }
    case "deployment_access_denied":
      return `${fenceUntrusted(error.message ?? "", "deployment-error")} Nothing changed.`;
    default:
      return "The redeploy failed. Try again later.";
  }
}

function redeployTool(redeploy: Redeploy) {
  return defineWriteTool({
    name: "redeploy_deployment",
    title: "Redeploy Deployment",
    description: `Rebuild a finished deployment as a new deployment, like Redeploy on the Deployments page: from the same git commit, or from the files uploaded for it. Only deployments from the last ${env.DEPLOYMENTS_REDEPLOY_WINDOW_DAYS} days that are ${FINAL_DEPLOYMENT_STATUSES.join(", ")} can be redeployed. The build runs in the background; by default the new deployment becomes current if its build succeeds and nothing newer is current by then. Identify it by its short code from list_deploys; for preview pass the branch.`,
    shape: RedeployInput.shape,
    approval: "required",
    auth: { ...auth, resolveSubject: resolvePreviewBranchSubject },
    confirm: {
      preview: async (args, subject) => {
        const plan = await planRedeploy(args, subject);
        return "refuse" in plan ? plan : plan.preview;
      },
    },
    run: async (input, ctx) => {
      const plan = await planRedeploy(input, ctx.subject);
      if ("refuse" in plan) return plainError(plan.refuse);
      const stale = staleApproval(ctx, plan.preview, plainError);
      if (stale) return stale;

      const promote = input.promote ?? true;
      const result = await redeploy({
        userId: ctx.identity.userId,
        projectId: ctx.subject!.projectId!,
        deploymentShortCode: plan.deployment.shortCode,
        skipPromotion: !promote,
      });
      if (result.isErr()) {
        if (result.error.type === "other") {
          logger.error("mcp.tool failed", {
            tool: "redeploy_deployment",
            error: `redeploy_deployment: ${result.error.cause instanceof Error ? result.error.cause.message : String(result.error.cause)}`,
          });
        }
        return plainError(
          redeployRefusal(result.error, describeDeploymentForAgent(plan.deployment))
        );
      }
      return textResult(
        `Started deployment ${describeDeploymentForAgent({ ...result.value, git: null })} (PENDING) from ${describeDeploymentForAgent(plan.deployment)}. It builds in the background and ${promote ? "becomes current if the build succeeds and nothing newer is current by then" : "is not made current when it finishes"}. Follow it with get_deployment_details.`
      );
    },
  });
}

type DeployNow = TriggerDeployNowService["call"];
const defaultDeployNow: DeployNow = (opts) => new TriggerDeployNowService().call(opts);

type TrackedPlan = {
  environment: { id: string; type: RuntimeEnvironmentType; branchName: string | null };
  branch: string;
  repository: { installationId: number; fullName: string };
  preview: string;
};

const NOTHING_CHANGED = "; nothing changed.";

// The same gates as the Dashboard's Deploy now action, in its order.
/** The external systems behind the Deploy now gates: the deploy access plugin and the billing gate. */
type DeployNowGates = {
  controller?: DeploymentAccessController | null;
  resolveCardGate?: (organizationId: string) => Promise<CardVerificationGate>;
};

async function planDeployTracked(
  args: { branch?: string },
  subject: McpSubject | null,
  gates: DeployNowGates,
  fingerprintKey: string
): Promise<TrackedPlan | { refuse: string }> {
  if (!subject?.environmentId || !subject.projectId) {
    return { refuse: `Environment not found${NOTHING_CHANGED}` };
  }
  const environment = await prisma.runtimeEnvironment.findFirst({
    where: { id: subject.environmentId, projectId: subject.projectId },
    select: {
      ...environmentSelect,
      archivedAt: true,
      organization: { select: { id: true, slug: true, title: true, featureFlags: true } },
    },
  });
  if (!environment) return { refuse: `Environment not found${NOTHING_CHANGED}` };
  const branchRefusal = await previewBranchRefusal(environment, args.branch);
  if (branchRefusal) return { refuse: branchRefusal };
  // The gate may have resolved it on a lagging replica; the primary decides.
  if (environment.archivedAt) {
    return {
      refuse: `This preview branch is archived and takes no new deployments${NOTHING_CHANGED}`,
    };
  }
  if (isBranchableEnvironment(environment)) return { refuse: PREVIEW_PARENT };
  const organization = environment.organization;

  if (!(await deploymentOnboardingEnabled(organization.id, prisma))) {
    return {
      refuse: `The Deploy now feature is not enabled for this organization, and it can't be enabled from here${NOTHING_CHANGED}`,
    };
  }
  const access = await checkDeployAccess(
    { stage: "preflight", organizationId: organization.id },
    { controller: gates.controller }
  );
  if (!access.allowed) {
    return {
      refuse: `${access.message ? fenceUntrusted(access.message, "deployment-error") : "Deploying is not allowed for this organization right now."} Nothing changed.`,
    };
  }
  const cardRefusal = await cardVerificationDeployRefusal(organization, {
    resolveGate: gates.resolveCardGate,
  });
  if (cardRefusal) {
    return { refuse: `${fenceUntrusted(cardRefusal, "deployment-error")} Nothing changed.` };
  }

  const connected = await prisma.connectedGithubRepository.findFirst({
    where: { projectId: subject.projectId },
    select: {
      branchTracking: true,
      previewDeploymentsEnabled: true,
      repository: {
        select: {
          id: true,
          fullName: true,
          installation: { select: { appInstallationId: true } },
        },
      },
    },
  });
  if (!connected) {
    return { refuse: `This project has no connected GitHub repository${NOTHING_CHANGED}` };
  }
  const tracking = BranchTrackingConfigSchema.safeParse(connected.branchTracking);
  const branch = tracking.success
    ? getTrackedBranchForEnvironment(tracking.data, connected.previewDeploymentsEnabled, {
        type: environment.type,
        branchName: environment.branchName ?? undefined,
      })
    : undefined;
  if (!branch) {
    return {
      refuse: `No branch is tracked for ${environmentLabelForAgent(environment)}. Set one in the project's Git settings${NOTHING_CHANGED}`,
    };
  }
  // The build service creates the preview environment by the normalised name; a name that
  // normalises to another would deploy outside this environment.
  if (environment.type === "PREVIEW" && sanitizeBranchName(branch) !== branch) {
    return {
      refuse: `The branch name ${agentFence(branch, "branch-name")} would deploy to preview branch ${agentFence(sanitizeBranchName(branch) ?? "", "branch-name")} instead of this one${NOTHING_CHANGED}`,
    };
  }

  const vercelUrl = await atomicProductionDeploymentUrl(
    subject.projectId,
    environment.type,
    prisma
  );
  if (vercelUrl) {
    return {
      refuse:
        "This environment is deployed together with Vercel. Deploy it from Vercel; nothing changed.",
    };
  }
  const inFlight = await prisma.workerDeployment.findFirst({
    // oxlint-disable-next-line trigger-prisma/no-unbounded-list-filter -- Fixed four deployment statuses.
    where: { environmentId: environment.id, status: { in: IN_PROGRESS } },
    select: { version: true, shortCode: true, status: true },
  });
  if (inFlight) {
    return {
      refuse: `Deployment ${describeDeploymentForAgent({ ...inFlight, git: null })} is still ${inFlight.status} in this environment. Wait for it to finish or cancel it with cancel_deployment; nothing changed.`,
    };
  }

  const current = await prisma.workerDeploymentPromotion.findFirst({
    where: { environmentId: environment.id, label: CURRENT_DEPLOYMENT_LABEL },
    select: { deployment: { select: { version: true, shortCode: true, git: true } } },
  });
  const replaced = current ? describeDeploymentForPreview(current.deployment) : undefined;
  const preview = [
    `Deploy the tracked branch ${previewQuote(branch)} of ${previewQuote(connected.repository.fullName)} to ${environmentLabelForPreview(environment)}: a new deployment builds the latest commit on that branch on GitHub at the time it runs.`,
    "It starts a new build, which uses build time, and runs in the background.",
    `The new deployment becomes current if its build succeeds and nothing newer is current by then${replaced ? `, replacing ${replaced}` : ""}.`,
    // Quoted names are clipped; this binds the full repository and branch.
    `Source ${trackedFingerprint(fingerprintKey, subject.projectId, connected.repository.id, connected.repository.fullName, branch)}.`,
  ].join(" ");
  return {
    environment,
    branch,
    repository: {
      installationId: Number(connected.repository.installation.appInstallationId),
      fullName: connected.repository.fullName,
    },
    preview,
  };
}

function deployNowAnswer(result: DeployNowResult, plan: TrackedPlan): string {
  const branch = agentFence(plan.branch, "branch-name");
  if (result.ok) {
    return `Started a deployment of the tracked branch ${branch} to ${environmentLabelForAgent(plan.environment)}. It builds in the background and shows up in list_deploys once the build service has created it; follow it with get_deployment_details.`;
  }
  switch (result.reason) {
    case "alreadyInFlight":
      return "A deployment is already in progress in this environment; nothing was started.";
    case "branchNotFound":
      return `The branch ${branch} doesn't exist in ${agentFence(plan.repository.fullName, "repository-name")}. Push it to GitHub, then deploy; nothing was started.`;
    case "atomicProduction":
      return "This environment is deployed together with Vercel. Deploy it from Vercel; nothing was started.";
    case "unsupportedEnvironment":
      return "This environment can't deploy a tracked branch; nothing was started.";
    default:
      return "The deployment could not be started. Check list_deploys before trying again.";
  }
}

const trackedFingerprint = (
  key: string,
  projectId: string,
  repositoryId: string,
  repository: string,
  branch: string
) =>
  createHmac("sha256", key)
    .update(JSON.stringify([projectId, "tracked-branch", repositoryId, repository, branch]))
    .digest("hex")
    .slice(0, 12);

function deployTrackedTool(
  deployNow: DeployNow,
  gates: DeployNowGates,
  fingerprintKey: () => Promise<string>
) {
  return defineWriteTool({
    name: "deploy_tracked_branch",
    title: "Deploy Tracked Branch",
    description:
      "Build and deploy the branch tracked for an environment from the connected GitHub repository, like Deploy now in the Dashboard. It builds the latest commit on that branch at the time it runs; the build runs in the background. For preview pass the branch.",
    shape: DeployTrackedBranchInput.shape,
    approval: "required",
    auth: { ...auth, resolveSubject: resolvePreviewBranchSubject },
    confirm: {
      preview: async (args, subject) => {
        const plan = await planDeployTracked(args, subject, gates, await fingerprintKey());
        return "refuse" in plan ? plan : plan.preview;
      },
    },
    run: async (input, ctx) => {
      const plan = await planDeployTracked(input, ctx.subject, gates, await fingerprintKey());
      if ("refuse" in plan) return plainError(plan.refuse);
      const stale = staleApproval(ctx, plan.preview, plainError);
      if (stale) return stale;

      const result = await deployNow({
        projectId: ctx.subject!.projectId!,
        environmentId: plan.environment.id,
        environmentType: plan.environment.type,
        branch: plan.branch,
        repository: plan.repository,
      });
      const answer = deployNowAnswer(result, plan);
      return result.ok ? textResult(answer) : plainError(answer);
    },
  });
}

export const createDeploymentsWriteTools = (
  fingerprintKey: () => Promise<string> = defaultFingerprintKey,
  redeploy: Redeploy = defaultRedeploy,
  deployNow: DeployNow = defaultDeployNow,
  deployNowGates: DeployNowGates = {}
): McpToolDefinition[] => [
  changeTool("promote", fingerprintKey),
  changeTool("rollback", fingerprintKey),
  redeployTool(redeploy),
  deployTrackedTool(deployNow, deployNowGates, fingerprintKey),
  defineWriteTool({
    name: "cancel_deployment",
    title: "Cancel Deployment",
    description:
      "Cancel a deployment that is still being built or deployed, like Cancel on the Deployments page. It never becomes current and this cannot be undone. Identify it by its short code from list_deploys; for preview pass the branch.",
    shape: DeploymentWriteInput.shape,
    approval: "configurable",
    auth,
    confirm: {
      preview: async (args, subject) => {
        const plan = await planCancel(args, subject);
        return "refuse" in plan ? plan : plan.preview;
      },
    },
    run: async (input, ctx) => {
      const plan = await planCancel(input, ctx.subject);
      if ("refuse" in plan) return plainError(plan.refuse);

      const outcome = await cancelOutcome(plan.environment.id, plan.deployment.friendlyId);
      const target = describeDeploymentForAgent(plan.deployment);
      if (outcome === "final") {
        return plainError(
          `Deployment ${target} reached a final state before it could be canceled; nothing changed.`
        );
      }
      if (outcome === "not_found")
        return plainError(deploymentNotFoundText(plan.deployment.shortCode));
      return textResult(`Canceled deployment ${target}.`);
    },
  }),
];

export const deploymentsWriteTools = createDeploymentsWriteTools();
