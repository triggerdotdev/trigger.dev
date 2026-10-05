import { getMeter, getTracer, ROOT_CONTEXT } from "@internal/tracing";
import type { AuthenticatedEnvironment } from "@trigger.dev/core/v3/auth/environment";
import { isAdditionalApiKey } from "@trigger.dev/core/v3/apiKeys";
import { isPublicJWT } from "@trigger.dev/core/v3/jwt";
import type { RbacAbility } from "@trigger.dev/rbac";
import { singleton } from "~/utils/singleton";
import { logger } from "~/services/logger.server";

const checks = singleton("sessionCreateAuthorizationChecks", () =>
  getMeter("session-authorization").createCounter("session.create.authorization_checks", {
    description:
      "Session creation requests admitted by current authorization, by proposed permission outcome",
  })
);

export function sessionCreateAuthorizationOutcome(
  ability: RbacAbility,
  taskIdentifier: string,
  sessionIds: string[] = []
) {
  const sessionWrite =
    ability.can("write", { type: "sessions" }) ||
    sessionIds.some((id) => ability.can("write", { type: "sessions", id }));
  const taskTrigger = ability.can("trigger", { type: "tasks", id: taskIdentifier });

  if (sessionWrite && taskTrigger) return "both_allowed";
  if (!sessionWrite && !taskTrigger) return "missing_both";
  return sessionWrite ? "missing_task_trigger" : "missing_session_write";
}

export function recordSessionCreateAuthorization(
  ability: RbacAbility,
  session: { taskIdentifier: string; friendlyId?: string; externalId?: string | null },
  request: Request,
  environment: Pick<AuthenticatedEnvironment, "id" | "organizationId" | "projectId" | "type">
) {
  const token =
    request.headers
      .get("Authorization")
      ?.replace(/^Bearer /, "")
      .trim() ?? "";
  const credentialKind = isPublicJWT(token)
    ? "public_jwt"
    : isAdditionalApiKey(token)
      ? "additional_api_key"
      : token.startsWith("tr_")
        ? "root_api_key"
        : "unknown";

  try {
    const outcome = sessionCreateAuthorizationOutcome(
      ability,
      session.taskIdentifier,
      [session.friendlyId, session.externalId].filter((id): id is string => !!id)
    );
    checks.add(1, { credential_kind: credentialKind, outcome });
    if (outcome === "both_allowed") return;

    // Force-record an independent root span so request sampling cannot hide affected tenants.
    getTracer("session-authorization")
      .startSpan(
        "session.create.authorization_would_deny",
        {
          attributes: {
            forceRecording: true,
            "$trigger.org.id": environment.organizationId,
            "$trigger.project.id": environment.projectId,
            "$trigger.env.id": environment.id,
            "$trigger.env.type": environment.type,
            "session.authorization.credential_kind": credentialKind,
            "session.authorization.outcome": outcome,
          },
        },
        ROOT_CONTEXT
      )
      .end();
  } catch {
    logger.debug("Session authorization observation failed");
  }
}
