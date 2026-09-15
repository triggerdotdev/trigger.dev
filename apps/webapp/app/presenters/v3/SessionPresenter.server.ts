import { type Span } from "@opentelemetry/api";
import { type PrismaClientOrTransaction, boundedIn } from "@trigger.dev/database";
import { env } from "~/env.server";
import { findDisplayableEnvironment } from "~/models/runtimeEnvironment.server";
import {
  DASHBOARD_TRANSCRIPT_PAGE,
  readSessionTranscriptSeed,
} from "~/services/realtime/transcriptSeed.server";
import { resolveSessionByIdOrExternalId } from "~/services/realtime/sessions.server";
import { LEGACY_PLAYGROUND_TAG } from "~/services/sessionsRepository/sessionsRepository.server";
import { runStore } from "~/v3/runStore.server";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import { startActiveSpan } from "~/v3/tracer.server";

export class SessionPresenter {
  constructor(private readonly replica: PrismaClientOrTransaction) {}

  public async call(args: {
    userId: string;
    environmentId: string;
    sessionParam: string;
    projectExternalRef: string;
    environmentSlug: string;
  }) {
    return startActiveSpan("SessionPresenter.call", (span) => this.#call(args, span), {
      attributes: {
        environmentId: args.environmentId,
        sessionParam: args.sessionParam,
      },
    });
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
    const session = await startActiveSpan("SessionPresenter.resolveSession", () =>
      resolveSessionByIdOrExternalId(this.replica, environmentId, sessionParam)
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
    const sessionRuns = await startActiveSpan("SessionPresenter.findSessionRuns", async (span) => {
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
    });

    const runIds = sessionRuns.map((r) => r.runId);
    const runs = await startActiveSpan("SessionPresenter.findRuns", async (span) => {
      span.setAttribute("runIds.count", runIds.length);
      return runIds.length > 0
        ? runStore.findRuns(
            {
              where: { id: { in: boundedIn(runIds) } },
              select: { id: true, friendlyId: true, status: true },
            },
            this.replica
          )
        : [];
    });
    const runsById = new Map(runs.map((r) => [r.id, r] as const));

    const currentRun = session.currentRunId
      ? (runsById.get(session.currentRunId) ??
        (await startActiveSpan("SessionPresenter.findCurrentRunFallback", () =>
          runStore.findRun(
            { id: session.currentRunId! },
            {
              select: { id: true, friendlyId: true, status: true },
            },
            this.replica
          )
        )))
      : null;

    // The dashboard SSE route is cookie-authed, so `publicAccessToken` is
    // unused — kept here to match the existing `AgentViewAuth` shape.
    const addressingKey = session.externalId ?? session.friendlyId;

    // Read the head of the transcript here rather than handing the browser a
    // presigned URL for the whole blob. The client seeds from these messages
    // and resumes the SSE from the snapshot's cursor.
    //
    // Snapshots are only written when no `hydrateMessages` hook is registered —
    // sessions that use `hydrateMessages` have no object to read and fall back
    // to seq=0 SSE (which, post-trim, shows only the most recent turn —
    // accepted, those customers have their own DB-backed dashboards).
    const transcriptSeed = await startActiveSpan("SessionPresenter.readTranscript", () =>
      readSessionTranscriptSeed({
        session,
        projectRef: projectExternalRef,
        envSlug: environmentSlug,
        limit: DASHBOARD_TRANSCRIPT_PAGE,
      })
    );

    return {
      id: session.id,
      friendlyId: session.friendlyId,
      externalId: session.externalId,
      type: session.type,
      taskIdentifier: session.taskIdentifier,
      isTest: session.isTest,
      // Hide the legacy "playground" tag (pre-isTest sessions) from display.
      tags: session.tags
        ? [...session.tags]
            .filter((t) => t !== LEGACY_PLAYGROUND_TAG)
            .sort((a, b) => a.localeCompare(b))
        : [],
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
          run: run ? { friendlyId: run.friendlyId, status: run.status } : null,
        };
      }),
      agentView: {
        publicAccessToken: "",
        apiOrigin: env.API_ORIGIN || env.LOGIN_ORIGIN,
        sessionId: addressingKey,
        initialMessages: [],
        transcriptSeed,
      },
    };
  }
}
