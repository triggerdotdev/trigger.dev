import { type Span } from "@opentelemetry/api";
import { chatSnapshotKeySuffix } from "@trigger.dev/core/v3";
import { type PrismaClientOrTransaction } from "@trigger.dev/database";
import { env } from "~/env.server";
import { findDisplayableEnvironment } from "~/models/runtimeEnvironment.server";
import { resolveSessionByIdOrExternalId } from "~/services/realtime/sessions.server";
import { logger } from "~/services/logger.server";
import { generatePresignedUrl } from "~/v3/objectStore.server";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import { startActiveSpan } from "~/v3/tracer.server";

export type SessionDetail = NonNullable<Awaited<ReturnType<SessionPresenter["call"]>>>;

export class SessionPresenter {
  constructor(private readonly replica: PrismaClientOrTransaction) {}

  public async call(args: {
    userId: string;
    environmentId: string;
    sessionParam: string;
    projectExternalRef: string;
    environmentSlug: string;
  }) {
    return startActiveSpan(
      "SessionPresenter.call",
      (span) => this.#call(args, span),
      {
        attributes: {
          environmentId: args.environmentId,
          sessionParam: args.sessionParam,
        },
      }
    );
  }

  async #call(
    {
      userId,
      environmentId,
      sessionParam,
      projectExternalRef,
      environmentSlug,
    }: {
      userId: string;
      environmentId: string;
      sessionParam: string;
      projectExternalRef: string;
      environmentSlug: string;
    },
    rootSpan: Span
  ) {
    const session = await startActiveSpan(
      "SessionPresenter.resolveSession",
      () => resolveSessionByIdOrExternalId(this.replica, environmentId, sessionParam)
    );
    if (!session) {
      rootSpan.setAttribute("session.found", false);
      return null;
    }
    rootSpan.setAttribute("session.found", true);
    rootSpan.setAttribute("session.id", session.id);

    const displayableEnvironment = await startActiveSpan(
      "SessionPresenter.findDisplayableEnvironment",
      () => findDisplayableEnvironment(environmentId, userId)
    );
    if (!displayableEnvironment) {
      throw new ServiceValidationError("No environment found");
    }

    // Run history is append-only; latest first matches the runs list.
    // 50 covers the vast majority of sessions; longer histories link out
    // to the runs page via tag filter.
    const sessionRuns = await startActiveSpan(
      "SessionPresenter.findSessionRuns",
      async (span) => {
        const rows = await this.replica.sessionRun.findMany({
          where: { sessionId: session.id },
          orderBy: { triggeredAt: "desc" },
          take: 50,
          select: {
            id: true,
            runId: true,
            reason: true,
            triggeredAt: true,
          },
        });
        span.setAttribute("sessionRuns.count", rows.length);
        return rows;
      }
    );

    const runIds = sessionRuns.map((r) => r.runId);
    const runs = await startActiveSpan(
      "SessionPresenter.findRuns",
      async (span) => {
        span.setAttribute("runIds.count", runIds.length);
        return runIds.length > 0
          ? this.replica.taskRun.findMany({
              where: { id: { in: runIds } },
              select: { id: true, friendlyId: true, status: true },
            })
          : [];
      }
    );
    const runsById = new Map(runs.map((r) => [r.id, r] as const));

    const currentRun = session.currentRunId
      ? runsById.get(session.currentRunId) ??
        (await startActiveSpan(
          "SessionPresenter.findCurrentRunFallback",
          () =>
            this.replica.taskRun.findFirst({
              where: { id: session.currentRunId! },
              select: { id: true, friendlyId: true, status: true },
            })
        ))
      : null;

    // The dashboard SSE route is cookie-authed, so `publicAccessToken` is
    // unused — kept here to match the existing `AgentViewAuth` shape.
    const addressingKey = session.externalId ?? session.friendlyId;

    // Presign a GET URL for the agent's S3 snapshot blob. The browser
    // fetches it directly, parses + validates, and seeds the
    // TriggerChatTransport with the full history + lastEventId before
    // opening the SSE. Presign succeeds regardless of whether the blob
    // exists; the frontend handles 404 gracefully.
    //
    // Snapshots are only written when no `hydrateMessages` hook is
    // registered — sessions that use `hydrateMessages` will 404 here
    // and the dashboard falls back to seq=0 SSE (which, post-trim,
    // shows only the most recent turn — accepted, those customers
    // have their own DB-backed dashboards).
    // The agent writes snapshots keyed on the session's friendlyId (the
    // `session_*` form), which matches what the SDK's `chat.agent` payload
    // carries as `sessionId`. Use the same key shape here so the dashboard
    // hits the same S3 object.
    let snapshotPresignedUrl: string | undefined;
    try {
      const signed = await startActiveSpan(
        "SessionPresenter.presignSnapshot",
        async () =>
          generatePresignedUrl(
            projectExternalRef,
            environmentSlug,
            chatSnapshotKeySuffix(session.friendlyId),
            "GET"
          )
      );
      if (signed.success) {
        snapshotPresignedUrl = signed.url;
      } else {
        logger.warn("SessionPresenter: snapshot presign failed", {
          sessionId: session.id,
          error: signed.error,
        });
      }
    } catch (error) {
      logger.warn("SessionPresenter: snapshot presign threw", {
        sessionId: session.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return {
      id: session.id,
      friendlyId: session.friendlyId,
      externalId: session.externalId,
      type: session.type,
      taskIdentifier: session.taskIdentifier,
      tags: session.tags ? [...session.tags].sort((a, b) => a.localeCompare(b)) : [],
      metadata: session.metadata,
      triggerConfig: session.triggerConfig,
      streamBasinName: session.streamBasinName,
      closedAt: session.closedAt ? session.closedAt.toISOString() : undefined,
      closedReason: session.closedReason ?? undefined,
      expiresAt: session.expiresAt ? session.expiresAt.toISOString() : undefined,
      createdAt: session.createdAt.toISOString(),
      updatedAt: session.updatedAt.toISOString(),
      environment: displayableEnvironment,
      currentRun: currentRun
        ? { friendlyId: currentRun.friendlyId, status: currentRun.status }
        : null,
      runs: sessionRuns.map((r) => {
        const run = runsById.get(r.runId);
        return {
          id: r.id,
          reason: r.reason,
          triggeredAt: r.triggeredAt.toISOString(),
          run: run
            ? { friendlyId: run.friendlyId, status: run.status }
            : null,
        };
      }),
      agentView: {
        publicAccessToken: "",
        apiOrigin: env.API_ORIGIN || env.LOGIN_ORIGIN,
        sessionId: addressingKey,
        initialMessages: [],
        snapshotPresignedUrl,
      },
    };
  }
}
