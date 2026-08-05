import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import {
  appendChatMessage,
  cancelWatch,
  chatExists,
  countUnreadWatchWakes,
  countUserMessages,
  createChat,
  getChatMessages,
  getSession,
  getWatch,
  listChatIdsWithOpenInvestigations,
  listChatIdsWithUnreadWakes,
  listChats,
  markChatRead,
  readWatchWakeFeed,
  renameChat,
  setChatPinned,
} from "@internal/dashboard-agent-db";
import {
  VIEW_BLOCK_VERSION,
  watchDraftSchema,
  type WatchDraft,
} from "@internal/dashboard-agent-contracts";
import { generateFriendlyId } from "@trigger.dev/core/v3/isomorphic";
import type { UIMessage } from "ai";
import { z } from "zod";
import {
  checkMessageParts,
  declaredBodyBytes,
  exceedsMessageBodyBytes,
  MESSAGE_TOO_LARGE_CODE,
  MESSAGE_TOO_LARGE_ERROR,
} from "~/components/dashboard-agent/message-limits";
import { $replica } from "~/db.server";
import { env } from "~/env.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import {
  watchConfirmationBlockBody,
  watchOneShotBlockBody,
  watchSubjectLabel,
} from "~/presenters/v3/dashboardAgent";
import { subscribeUserToWatchAlerts } from "~/services/dashboardAgentWatchAlerts.server";
import {
  authorizeWatchEnvironmentById,
  createDashboardAgentWatch,
  deleteChatWithWatches,
  listActiveWatchesForChats,
} from "~/services/dashboardAgentWatches.server";
import {
  dashboardAgentApiOrigin,
  isDashboardAgentConfigured,
  mintDashboardAgentToken,
  mintDashboardAgentUserActorToken,
  resolveDashboardAgentRepoSnapshot,
  startDashboardAgentSession,
} from "~/services/dashboardAgent.server";
import { startDashboardAgentHeadStart } from "~/services/dashboardAgentHeadStart.server";
import { dashboardAgentDb } from "~/services/dashboardAgentDb.server";
import { logger } from "~/services/logger.server";
import { resolveTriggerUri } from "~/services/resolveTriggerUri.server";
import { requireUser } from "~/services/session.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";
import { canAccessDashboardAgent } from "~/v3/canAccessDashboardAgent.server";

// The agent's tools address the canonical env name, not the dashboard URL slug.
const ENV_NAME_BY_TYPE: Record<string, string> = {
  DEVELOPMENT: "dev",
  STAGING: "staging",
  PRODUCTION: "prod",
  PREVIEW: "preview",
};

const ActionBody = z.object({
  intent: z.enum([
    "start",
    "create",
    "token",
    "rename",
    "pin",
    "delete",
    "read",
    "resolve",
    "watch-cancel",
    "watch-create",
  ]),
  // Omitted for `create` (the server generates it); required for the rest.
  chatId: z.string().min(1).optional(),
  // The first user message (JSON UIMessage), for `create`.
  message: z.string().optional(),
  clientData: z.string().optional(),
  title: z.string().optional(),
  pinned: z.enum(["true", "false"]).optional(),
  // A `trigger://` URI, for `resolve`.
  uri: z.string().optional(),
  // The watch to cancel, for `watch-cancel`.
  watchId: z.string().min(1).optional(),
  // The configured card, for `watch-create`: a JSON `WatchDraft`.
  draft: z.string().optional(),
});

// History list by default. `?chatId=` returns the stored transcript plus session,
// `?unread=1` the unread wake count and recent wakes, `?quota=1` the message count.
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const user = await requireUser(request);
  const userId = user.id;
  const { organizationSlug, projectParam } = EnvironmentParamSchema.parse(params);

  if (
    !(await canAccessDashboardAgent({
      userId,
      isAdmin: user.admin,
      isImpersonating: user.isImpersonating,
      organizationSlug,
    }))
  ) {
    return json({ error: "Not found" }, { status: 404 });
  }

  const searchParams = new URL(request.url).searchParams;

  // The wake poll runs once a minute per open tab, so it reads only the org id it needs
  // and asks the agent DB one question. The list is recent deliveries, not unread ones;
  // the client dedupes by id.
  if (searchParams.get("unread") === "1") {
    const scoped = await $replica.project.findFirst({
      where: {
        slug: projectParam,
        organization: { slug: organizationSlug, members: { some: { userId } } },
      },
      select: { organizationId: true },
    });
    if (!scoped) return json({ error: "Project not found" }, { status: 404 });

    return json(
      await readWatchWakeFeed(dashboardAgentDb, {
        organizationId: scoped.organizationId,
        userId,
        deliveredAfter: new Date(Date.now() - 15 * 60 * 1000),
      })
    );
  }

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) return json({ error: "Project not found" }, { status: 404 });

  // The open chat is excluded and counted from the live transcript instead, so an
  // unpersisted turn still counts against the cap.
  if (searchParams.get("quota") === "1") {
    const used = await countUserMessages(dashboardAgentDb, {
      organizationId: project.organizationId,
      userId,
      excludeChatId: searchParams.get("chatId") ?? undefined,
    });
    return json({ used });
  }

  const chatId = searchParams.get("chatId");
  if (chatId) {
    const [messages, session] = await Promise.all([
      getChatMessages(dashboardAgentDb, { chatId, userId, organizationId: project.organizationId }),
      getSession(dashboardAgentDb, { chatId, userId, organizationId: project.organizationId }),
    ]);
    return json({ messages: messages ?? [], session });
  }

  const chats = await listChats(dashboardAgentDb, {
    organizationId: project.organizationId,
    userId,
  });

  // One query each for all the listed chats, never one per row.
  const [watchesByChat, unreadWakes, unreadChatIds, investigatingChatIds] = await Promise.all([
    listActiveWatchesForChats({
      chatIds: chats.map((chat) => chat.id),
      organizationId: project.organizationId,
      userId,
    }),
    countUnreadWatchWakes(dashboardAgentDb, {
      organizationId: project.organizationId,
      userId,
    }),
    listChatIdsWithUnreadWakes(dashboardAgentDb, {
      organizationId: project.organizationId,
      userId,
    }),
    listChatIdsWithOpenInvestigations(dashboardAgentDb, {
      organizationId: project.organizationId,
      userId,
    }),
  ]);

  return json({
    chats: chats.map((chat) => {
      const watches = watchesByChat[chat.id] ?? [];
      return {
        ...chat,
        watches,
        hasUnreadWake: unreadChatIds.has(chat.id),
        // `watches` also carries fired and expired rows, so check for active here.
        hasActiveWatch: watches.some((watch) => watch.status === "active"),
        hasOpenInvestigation: investigatingChatIds.has(chat.id),
      };
    }),
    unreadWakes,
  });
};

function messageTooLarge() {
  return json({ error: MESSAGE_TOO_LARGE_ERROR, code: MESSAGE_TOO_LARGE_CODE }, { status: 413 });
}

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const user = await requireUser(request);
  const userId = user.id;
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  if (
    !(await canAccessDashboardAgent({
      userId,
      isAdmin: user.admin,
      isImpersonating: user.isImpersonating,
      organizationSlug,
    }))
  ) {
    return json({ error: "Not found" }, { status: 404 });
  }

  // Refused before any lookup, so an oversized body costs nothing.
  if (exceedsMessageBodyBytes(declaredBodyBytes(request.headers))) {
    return messageTooLarge();
  }

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) return json({ error: "Project not found" }, { status: 404 });

  const parsed = ActionBody.safeParse(Object.fromEntries(await request.formData()));
  if (!parsed.success) return json({ error: "Invalid request" }, { status: 400 });

  // The server generates the chat id, so a client can never name another user's chat.
  if (parsed.data.intent === "create") {
    if (!isDashboardAgentConfigured()) {
      return json({ error: "The dashboard agent is not configured." }, { status: 501 });
    }

    let firstMessage: UIMessage | undefined;
    try {
      firstMessage = parsed.data.message
        ? (JSON.parse(parsed.data.message) as UIMessage)
        : undefined;
    } catch {
      return json({ error: "Invalid message" }, { status: 400 });
    }
    if (!firstMessage) return json({ error: "message is required" }, { status: 400 });

    // A body under the byte cap can still be one huge part or hundreds of small ones.
    if (
      exceedsMessageBodyBytes(Buffer.byteLength(parsed.data.message ?? "", "utf8")) ||
      checkMessageParts(firstMessage.parts) !== null
    ) {
      return messageTooLarge();
    }

    let clientData: Record<string, unknown> | undefined;
    try {
      clientData = parsed.data.clientData
        ? (JSON.parse(parsed.data.clientData) as Record<string, unknown>)
        : undefined;
    } catch {
      /* invalid JSON — create without context metadata */
    }

    const chatId = generateFriendlyId("chat");
    try {
      await createChat(dashboardAgentDb, {
        id: chatId,
        organizationId: project.organizationId,
        userId,
        ...(clientData ? { metadata: { context: clientData } } : {}),
      });

      const runtimeEnv = await $replica.runtimeEnvironment.findFirst({
        where: { projectId: project.id, slug: envParam },
        select: { id: true, type: true },
      });
      const environmentName = runtimeEnv ? ENV_NAME_BY_TYPE[runtimeEnv.type] : undefined;
      const repoSnapshot = await resolveDashboardAgentRepoSnapshot(project.id);

      const headStarted = Boolean(env.ANTHROPIC_API_KEY);
      if (headStarted) {
        // Injects the delegated token and context into the run's payload server-side.
        await startDashboardAgentHeadStart({
          chatId,
          messages: [firstMessage],
          mode: repoSnapshot ? "code" : "assistant",
          metadata: {
            // The agent validates run metadata against its clientDataSchema, so the
            // per-turn clientData must accompany the injected auth and context fields.
            ...(clientData ?? {}),
            userActorToken: await mintDashboardAgentUserActorToken(userId, {
              environmentId: runtimeEnv?.id,
            }),
            apiOrigin: dashboardAgentApiOrigin(),
            projectRef: project.externalRef,
            // Same environment identity the `in` proxy injects.
            environmentId: runtimeEnv?.id,
            environmentName,
            ...(repoSnapshot ? { repoSnapshot } : {}),
          },
        });
      } else {
        // Cold start: the client sends the first message through the `in` proxy, which
        // injects the token.
        await startDashboardAgentSession({ chatId, clientData });
      }

      const publicAccessToken = await mintDashboardAgentToken(chatId);
      return json({ chatId, publicAccessToken, headStarted });
    } catch (error) {
      logger.error("Failed to create dashboard agent chat", { chatId, error });
      return json(
        { error: "The dashboard agent couldn't start. Please try again in a moment." },
        { status: 500 }
      );
    }
  }

  // Scoped by the environment in the URL: the resolver refuses a URI naming a
  // different project or environment.
  if (parsed.data.intent === "resolve") {
    const uri = parsed.data.uri;
    if (!uri) return json({ error: "uri is required" }, { status: 400 });

    const environment = await findEnvironmentBySlug(project.id, envParam, userId);
    if (!environment) return json({ error: "Environment not found" }, { status: 404 });

    // Only a source URI needs the connected repository.
    const repository = uri.includes("/source/")
      ? await $replica.connectedGithubRepository.findFirst({
          where: {
            projectId: project.id,
            repository: { installation: { deletedAt: null, suspendedAt: null } },
          },
          select: { repository: { select: { fullName: true } } },
        })
      : null;

    const resolved = resolveTriggerUri(
      { ...environment, repository: repository?.repository ?? null },
      uri
    );
    if (!resolved) return json({ error: "Nothing to open for that link" }, { status: 404 });

    return json({
      path: resolved.url,
      label: resolved.label,
      external: resolved.external ?? false,
    });
  }

  // The configuration card's submit path. The environment comes from the URL and goes
  // through the same re-authorization a background tick passes, never from the body.
  if (parsed.data.intent === "watch-create") {
    let draft: WatchDraft;
    try {
      const result = watchDraftSchema.safeParse(JSON.parse(parsed.data.draft ?? ""));
      if (!result.success) {
        return json({ error: "That watch isn't valid.", code: "invalid_request" }, { status: 400 });
      }
      draft = result.data;
    } catch {
      return json({ error: "That watch isn't valid.", code: "invalid_request" }, { status: 400 });
    }

    const runtimeEnv = await findEnvironmentBySlug(project.id, envParam, userId);
    if (!runtimeEnv) return json({ error: "Environment not found" }, { status: 404 });

    const environment = await authorizeWatchEnvironmentById({
      userId,
      environmentId: runtimeEnv.id,
    });
    if (!environment) {
      return json({ error: "Environment not found", code: "invalid_target" }, { status: 404 });
    }

    // A watch is chat-bound, so a card submitted from a fresh panel creates a chat.
    let targetChatId = parsed.data.chatId;
    if (targetChatId) {
      if (
        !(await chatExists(dashboardAgentDb, {
          chatId: targetChatId,
          userId,
          organizationId: project.organizationId,
        }))
      ) {
        return json({ error: "Chat not found", code: "chat_not_found" }, { status: 404 });
      }
    } else {
      targetChatId = generateFriendlyId("chat");
      await createChat(dashboardAgentDb, {
        id: targetChatId,
        organizationId: project.organizationId,
        userId,
        title: `Watch ${watchSubjectLabel(draft.spec)}`,
      });
    }

    const result = await createDashboardAgentWatch({
      environment,
      userId,
      chatId: targetChatId,
      spec: draft.spec,
      investigateOnAttention: draft.followUp.investigateOnAttention,
    });

    // Returns before any append, so a failed creation persists nothing.
    if (!result.ok) {
      const status =
        result.code === "limit_reached" || result.code === "duplicate"
          ? 409
          : result.code === "invalid_target" || result.code === "chat_not_found"
            ? 404
            : result.code === "not_configured"
              ? 501
              : 500;
      return json(
        {
          error: result.error,
          code: result.code,
          ...(result.existingId ? { existingId: result.existingId } : {}),
        },
        { status }
      );
    }

    // Attached after the watch exists, and a refusal never fails the creation.
    let notifiedExternally = false;
    if (result.watching && draft.followUp.notifyExternally) {
      const subscribed = await subscribeUserToWatchAlerts({ userId, environment });
      notifiedExternally = subscribed.ok;
    }

    const body = result.watching
      ? watchConfirmationBlockBody({
          spec: draft.spec,
          watchId: result.watchId,
          unavailable: result.unavailable,
          followUp: {
            investigateOnAttention: draft.followUp.investigateOnAttention,
            notifyExternally: notifiedExternally,
          },
        })
      : watchOneShotBlockBody({
          spec: draft.spec,
          result: result.immediate.result as "satisfied" | "terminal_unsatisfied",
        });

    // `id` is the watch (or the identity, for a one-shot), so a retried submit
    // replaces the block.
    const message = {
      id: `watch-card:${result.watching ? result.watchId : result.identity}`,
      role: "assistant" as const,
      parts: [
        {
          type: "data-view" as const,
          data: {
            blocks: [
              {
                ...body,
                revision: 0,
                version: VIEW_BLOCK_VERSION,
                id: `watch:${result.watching ? result.watchId : result.identity}`,
              },
            ],
          },
        },
      ],
    };

    await appendChatMessage(dashboardAgentDb, {
      chatId: targetChatId,
      userId,
      organizationId: project.organizationId,
      message,
    });

    return json({
      chatId: targetChatId,
      watching: result.watching,
      watchId: result.watching ? result.watchId : null,
      message,
    });
  }

  const { intent, chatId } = parsed.data;
  if (!chatId) return json({ error: "chatId is required" }, { status: 400 });

  switch (intent) {
    case "start": {
      if (!isDashboardAgentConfigured()) {
        return json({ error: "The dashboard agent is not configured." }, { status: 501 });
      }
      // Resume only, so a client-supplied chatId is checked against the caller first.
      if (
        !(await chatExists(dashboardAgentDb, {
          chatId,
          userId,
          organizationId: project.organizationId,
        }))
      ) {
        return json({ error: "Chat not found" }, { status: 404 });
      }
      let clientData: Record<string, unknown> | undefined;
      try {
        clientData = parsed.data.clientData
          ? (JSON.parse(parsed.data.clientData) as Record<string, unknown>)
          : undefined;
      } catch {
        /* invalid JSON — start without metadata */
      }
      try {
        const { publicAccessToken } = await startDashboardAgentSession({ chatId, clientData });
        return json({ publicAccessToken });
      } catch (error) {
        logger.error("Failed to start dashboard agent session", { chatId, error });
        return json(
          { error: "The dashboard agent couldn't start. Please try again in a moment." },
          { status: 500 }
        );
      }
    }

    case "token": {
      if (!isDashboardAgentConfigured()) {
        return json({ error: "The dashboard agent is not configured." }, { status: 501 });
      }
      // Only mint a token for a chat the caller owns.
      if (
        !(await chatExists(dashboardAgentDb, {
          chatId,
          userId,
          organizationId: project.organizationId,
        }))
      ) {
        return json({ error: "Chat not found" }, { status: 404 });
      }
      return json({ token: await mintDashboardAgentToken(chatId) });
    }

    case "rename": {
      if (!parsed.data.title) return json({ error: "title is required" }, { status: 400 });
      await renameChat(dashboardAgentDb, {
        chatId,
        userId,
        organizationId: project.organizationId,
        title: parsed.data.title,
      });
      return json({ ok: true });
    }

    case "pin": {
      await setChatPinned(dashboardAgentDb, {
        chatId,
        userId,
        organizationId: project.organizationId,
        pinned: parsed.data.pinned === "true",
      });
      return json({ ok: true });
    }

    // The update is owner-scoped, so a chatId the caller doesn't own is a no-op.
    case "read": {
      await markChatRead(dashboardAgentDb, {
        chatId,
        userId,
        organizationId: project.organizationId,
      });
      return json({ ok: true });
    }

    case "delete": {
      // `deleteChatWithWatches` is owner-scoped but takes no org, so the org scope has
      // to be enforced here.
      if (
        !(await chatExists(dashboardAgentDb, {
          chatId,
          userId,
          organizationId: project.organizationId,
        }))
      ) {
        return json({ error: "Chat not found" }, { status: 404 });
      }
      // The delete and the watch cancellations land in one transaction.
      const { cancelledWatches } = await deleteChatWithWatches({ chatId, userId });
      return json({ ok: true, cancelledWatches });
    }

    // Ownership goes through the chat: the watch must belong to the named chat, and
    // that chat to this user in this org.
    case "watch-cancel": {
      const watchId = parsed.data.watchId;
      if (!watchId) return json({ error: "watchId is required" }, { status: 400 });

      const watch = await getWatch(dashboardAgentDb, { id: watchId });
      if (!watch || watch.chatId !== chatId) {
        return json({ error: "Watch not found" }, { status: 404 });
      }

      if (
        !(await chatExists(dashboardAgentDb, {
          chatId,
          userId,
          organizationId: project.organizationId,
        }))
      ) {
        return json({ error: "Chat not found" }, { status: 404 });
      }

      // `cancelWatch` only touches an active row, so an already-resolved watch keeps
      // its outcome and this is a no-op.
      await cancelWatch(dashboardAgentDb, { id: watchId, reason: "user" });
      return json({ ok: true });
    }
  }
};
