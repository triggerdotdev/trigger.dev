import { SpanStatusCode } from "@opentelemetry/api";
import { type WorkerDeploymentStatus } from "@trigger.dev/database";
import { logger } from "~/services/logger.server";
import { tracer } from "~/v3/tracer.server";

type TerminalDeploymentStatus = Extract<
  WorkerDeploymentStatus,
  "DEPLOYED" | "FAILED" | "TIMED_OUT"
>;

/**
 * Records a deployment's terminal status as a `deployment.outcome` span so
 * deploy success/failure is queryable from traces (no DB read). Call after each
 * terminal-status write. Org/project/env are best-effort; never throws.
 */
export function recordDeploymentOutcome(params: {
  status: TerminalDeploymentStatus;
  deploymentFriendlyId: string;
  organizationId?: string;
  projectId?: string;
  environmentId?: string;
  environmentType?: string;
  reason?: string;
}): void {
  try {
    const span = tracer.startSpan("deployment.outcome", {
      attributes: {
        "$trigger.org.id": params.organizationId,
        "$trigger.project.id": params.projectId,
        "$trigger.env.id": params.environmentId,
        "$trigger.env.type": params.environmentType,
        "deployment.outcome.status": params.status,
        "deployment.outcome.success": params.status === "DEPLOYED",
        "deployment.outcome.deployment_id": params.deploymentFriendlyId,
        "deployment.outcome.reason": params.reason,
      },
    });

    if (params.status !== "DEPLOYED") {
      span.setStatus({ code: SpanStatusCode.ERROR, message: params.reason });
    }

    span.end();
  } catch (error) {
    logger.debug("recordDeploymentOutcome failed", {
      deploymentFriendlyId: params.deploymentFriendlyId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
