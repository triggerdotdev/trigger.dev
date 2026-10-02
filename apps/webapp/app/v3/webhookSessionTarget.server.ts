import { SessionTriggerConfig as SessionTriggerConfigSchema } from "@trigger.dev/core/v3";
import { Prisma, type PrismaClient, type Session } from "@trigger.dev/database";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import type { SessionTriggerConfig } from "~/services/realtime/sessionRunManager.server";
import { findOrCreateSession, findSessionByExternalId } from "~/services/realtime/sessions.server";

export type WebhookSessionResolution =
  | { kind: "resolved"; session: Session; isCached: boolean }
  | { kind: "skipped"; reason: string }
  | { kind: "rejected"; error: string };

/**
 * Resolve the session a webhook session target delivers to. An existing session is resumed only when
 * it belongs to the target's agent: session keys are unique per environment, not per agent, so a key
 * another agent already owns is rejected rather than handed the event. With no session yet, one is
 * started only when the event is a session start (`startOn`), and the created row is re-checked so a
 * concurrent create by another agent is rejected too. Nothing here appends to the session or boots a run.
 */
export async function resolveWebhookSession(params: {
  environment: AuthenticatedEnvironment;
  externalId: string;
  taskIdentifier: string;
  isSessionStart: boolean;
  triggerConfigTemplate?: Record<string, unknown>;
  db?: Pick<PrismaClient, "session">;
}): Promise<WebhookSessionResolution> {
  const { environment, externalId, taskIdentifier, db } = params;

  const existing = await findSessionByExternalId(environment, externalId, db);
  if (existing) {
    return checkSession(existing, taskIdentifier, externalId, true);
  }
  if (!params.isSessionStart) {
    return { kind: "skipped", reason: "startOn: not a session-start event" };
  }

  /** The template arrives unvalidated (`z.record(z.unknown())` on the routing
   * target), and continuations re-parse the stored row with a throwing parse,
   * so anything this path persists must parse or the session strands forever.
   * A bad template fails the CREATE delivery terminally; resumes never touch
   * the template, so a broken template can't stop existing sessions. Known
   * fields persist normalized while unknown template keys are kept as given;
   * a non-object `basePayload` is rejected rather than spread into index-keyed garbage. */
  const template = (params.triggerConfigTemplate ?? {}) as Partial<SessionTriggerConfig>;
  if (
    template.basePayload !== undefined &&
    (typeof template.basePayload !== "object" ||
      template.basePayload === null ||
      Array.isArray(template.basePayload))
  ) {
    return {
      kind: "rejected",
      error:
        "Invalid triggerConfigTemplate on the webhook routing target: basePayload must be an object",
    };
  }
  const assembled = {
    ...template,
    basePayload: {
      messages: [],
      trigger: "preload",
      chatId: externalId,
      ...(template.basePayload ?? {}),
    },
  };
  const parsedTriggerConfig = SessionTriggerConfigSchema.safeParse(assembled);
  if (!parsedTriggerConfig.success) {
    return {
      kind: "rejected",
      error: `Invalid triggerConfigTemplate on the webhook routing target: ${parsedTriggerConfig.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    };
  }
  const triggerConfig: SessionTriggerConfig = { ...assembled, ...parsedTriggerConfig.data };

  try {
    const { session, isCached } = await findOrCreateSession({
      environment,
      externalId,
      type: "chat.agent",
      taskIdentifier,
      triggerConfig,
      refreshTriggerConfig: false,
      db,
    });
    return checkSession(session, taskIdentifier, externalId, isCached);
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
      throw error;
    }
    const winner = await findSessionByExternalId(environment, externalId, db);
    if (!winner) throw error;
    return checkSession(winner, taskIdentifier, externalId, true);
  }
}

function checkSession(
  session: Session,
  taskIdentifier: string,
  externalId: string,
  isCached: boolean
): WebhookSessionResolution {
  if (session.taskIdentifier !== taskIdentifier) {
    return {
      kind: "rejected",
      error: `Session "${externalId}" belongs to agent "${session.taskIdentifier}", not "${taskIdentifier}"`,
    };
  }
  if (session.closedAt || (session.expiresAt && session.expiresAt.getTime() < Date.now())) {
    return { kind: "rejected", error: "Session is closed or expired" };
  }
  return { kind: "resolved", session, isCached };
}
