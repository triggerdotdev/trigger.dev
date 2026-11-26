import { createHmac } from "node:crypto";
import { CURRENT_DEPLOYMENT_LABEL } from "@trigger.dev/core/v3/isomorphic";
import type { WorkerDeployment, WorkerDeploymentStatus } from "@trigger.dev/database";
import { prisma } from "~/db.server";
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
import { DeploymentWriteInput } from "./schemas/environments";

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
  subject: McpSubject | null
): Promise<Located | { refuse: string }> {
  if (!subject?.environmentId || !subject.projectId)
    return { refuse: deploymentNotFoundText(args.shortCode) };
  const environment = await prisma.runtimeEnvironment.findFirst({
    where: { id: subject.environmentId, projectId: subject.projectId },
    select: environmentSelect,
  });
  if (!environment) return { refuse: deploymentNotFoundText(args.shortCode) };
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

const createDeploymentsWriteTools = (
  fingerprintKey: () => Promise<string> = defaultFingerprintKey
): McpToolDefinition[] => [
  changeTool("promote", fingerprintKey),
  changeTool("rollback", fingerprintKey),
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
