import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import {
  chatExists,
  countUnreadWatchWakes,
  countChatsWithUnreadWork,
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
  softDeleteChat,
} from "@internal/dashboard-agent-db";
import { watchDraftSchema, type WatchDraft } from "@internal/dashboard-agent-contracts";
import { dashboardAgentProvider } from "@internal/dashboard-agent/model-provider";
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
import { MESSAGE_QUOTA_REACHED_ERROR } from "~/components/dashboard-agent/message-quota";
import { MAX_URIS_PER_RESOLVE_REQUEST } from "~/components/dashboard-agent/resolve-uris";
import { $replica } from "~/db.server";
import { env } from "~/env.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import {
  authorizeWatchEnvironmentById,
  cancelDashboardAgentWatch,
  deleteChatWithWatches,
  listActiveWatchesForChats,
  submitDashboardAgentWatch,
} from "~/services/dashboardAgentWatches.server";
import {
  dashboardAgentApiOrigin,
  dashboardAgentWakeFeedCounter,
  isDashboardAgentConfigured,
  mintDashboardAgentToken,
  mintDashboardAgentUserActorToken,
  resolveDashboardAgentRepoSnapshot,
  startDashboardAgentSession,
} from "~/services/dashboardAgent.server";
import { dashboardAgentEnvironmentAddress } from "~/services/dashboardAgentEnvironmentAddress.server";
import { wellFormMessageText } from "~/services/dashboardAgentMessageText.server";
import { watchErrorStatus } from "~/services/dashboardAgentWatchErrorStatus.server";
import { startDashboardAgentHeadStart } from "~/services/dashboardAgentHeadStart.server";
import { dashboardAgentDb } from "~/services/dashboardAgentDb.server";
import {
  recordAgentMessageSent,
  resolveAgentMessageQuota,
  UNLIMITED_AGENT_MESSAGES,
} from "~/services/dashboardAgentQuota.server";
import { logger } from "~/services/logger.server";
import { resolveTriggerUri } from "~/services/resolveTriggerUri.server";
import { requireUser } from "~/services/session.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";
import { canAccessDashboardAgent } from "~/v3/canAccessDashboardAgent.server";
// The client-metadata whitelist lives with the `in` proxy, the other mint site, so the two cannot
// drift apart.
import { pickAgentClientMetadata } from "./resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.dashboard-agent.in.$";

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
    "resolve-many",
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
  // A JSON array of `trigger://` URIs, for `resolve-many`.
  uris: z.string().optional(),
  // The watch to cancel, for `watch-cancel`.
  watchId: z.string().min(1).optional(),
  // The configured card, for `watch-create`: a JSON `WatchDraft`.
  draft: z.string().optional(),
  // Stable per card submission, so a retried `watch-create` repairs instead of repeating.
  // Required for `watch-create`: see the check in that branch.
  clientRequestId: z.string().min(1).max(64).optional(),
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
    dashboardAgentWakeFeedCounter.inc();
    const scoped = await $replica.project.findFirst({
      where: {
        slug: projectParam,
        organization: { slug: organizationSlug, members: { some: { userId } } },
      },
      select: { organizationId: true },
    });
    if (!scoped) return json({ error: "Project not found" }, { status: 404 });

    const [feed, unreadWork] = await Promise.all([
      readWatchWakeFeed(dashboardAgentDb, {
        organizationId: scoped.organizationId,
        userId,
        deliveredAfter: new Date(Date.now() - 15 * 60 * 1000),
      }),
      // The dot has two sources; the poll is where a closed panel learns about either.
      countChatsWithUnreadWork(dashboardAgentDb, {
        organizationId: scoped.organizationId,
        userId,
        // The chat the panel has on screen, if any: it is being read as this is counted.
        excludeChatId: searchParams.get("chatId") ?? undefined,
      }),
    ]);

    return json({ ...feed, unreadWork });
  }

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) return json({ error: "Project not found" }, { status: 404 });

  // The per-period counter, org-wide: a deleted chat can't lower it within the period.
  if (searchParams.get("quota") === "1") {
    const quota = await resolveAgentMessageQuota(dashboardAgentDb, {
      organizationId: project.organizationId,
    });
    if (!quota) return json({});
    // The sentinel is "no plan limit" — send null so the client keeps its own free-plan nudge
    // instead of showing a number nobody would ever reach.
    return json({
      used: quota.used,
      limit: quota.limit < UNLIMITED_AGENT_MESSAGES ? quota.limit : null,
    });
  }

  const chatId = searchParams.get("chatId");
  if (chatId) {
    const [messages, session] = await Promise.all([
      getChatMessages(dashboardAgentDb, { chatId, userId, organizationId: project.organizationId }),
      getSession(dashboardAgentDb, { chatId, userId, organizationId: project.organizationId }),
    ]);
    // Null is not an empty transcript: the chat is deleted or another org's, and a 200 would
    // read as a real, empty chat.
    if (messages === null) return json({ error: "Chat not found" }, { status: 404 });
    return json({ messages, session });
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
        // Work that finished while the chat was closed: the transcript moved on after the
        // last time its owner looked. A wake is one way that happens, an answer is another.
        hasUnreadWork:
          chat.lastMessageAt !== null &&
          (chat.lastReadAt === null || chat.lastMessageAt > chat.lastReadAt),
        // `watches` also carries fired and expired rows, so check for active here.
        hasActiveWatch: watches.some((watch) => watch.status === "active"),
        hasOpenInvestigation: investigatingChatIds.has(chat.id),
      };
    }),
    unreadWakes,
  });
};

/** Only a source URI needs the connected repository, so a batch without one skips the read. */
async function findRepositoryForSourceUris(projectId: string, uris: string[]) {
  if (!uris.some((uri) => uri.includes("/source/"))) return null;

  const connected = await $replica.connectedGithubRepository.findFirst({
    where: {
      projectId,
      repository: { installation: { deletedAt: null, suspendedAt: null } },
    },
    select: { repository: { select: { fullName: true } } },
  });
  return connected?.repository ?? null;
}

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

  // A declared oversize is refused here, before any lookup. Without a content-length the
  // ingress cap has already ended the request mid-stream, so this never sees it.
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

    wellFormMessageText(firstMessage.parts);

    const quota = await resolveAgentMessageQuota(dashboardAgentDb, {
      organizationId: project.organizationId,
    });
    if (quota?.reached) {
      return json({ error: MESSAGE_QUOTA_REACHED_ERROR, limit: quota.limit }, { status: 403 });
    }

    let clientData: Record<string, unknown> | undefined;
    try {
      clientData = parsed.data.clientData
        ? (JSON.parse(parsed.data.clientData) as Record<string, unknown>)
        : undefined;
    } catch {
      /* invalid JSON — create without context metadata */
    }
    // Only the whitelisted page context survives; the rest is injected below.
    const clientContext = pickAgentClientMetadata(clientData);

    // Membership-scoped: dev rows are per-developer, so a token must never be minted for
    // someone else's environment — or, when nothing resolves, for no environment at all.
    const runtimeEnv = await findEnvironmentBySlug(project.id, envParam, userId);
    if (!runtimeEnv) return json({ error: "Environment not found" }, { status: 404 });
    const environmentAddress = dashboardAgentEnvironmentAddress(runtimeEnv);

    const chatId = generateFriendlyId("chat");
    try {
      const repoSnapshot = await resolveDashboardAgentRepoSnapshot(project.id);
      const headStarted =
        dashboardAgentProvider() === "bedrock"
          ? Boolean(env.DASHBOARD_AGENT_AWS_REGION || env.AWS_REGION || env.AWS_DEFAULT_REGION)
          : Boolean(env.ANTHROPIC_API_KEY);

      // The lookups and the mint all run before the chat row exists, so a failure here can't
      // leave an empty chat behind in the user's history.
      const headStartMetadata = headStarted
        ? {
            // The agent validates run metadata against its clientDataSchema, so the
            // per-turn client context must accompany the injected auth and context fields.
            ...clientContext,
            userActorToken: await mintDashboardAgentUserActorToken(userId, {
              environmentId: runtimeEnv.id,
            }),
            apiOrigin: dashboardAgentApiOrigin(),
            projectRef: project.externalRef,
            // Server-owned, like the `in` proxy: the eval opt-out and every tenancy check
            // key on these, so the client can't set them at all.
            organizationId: project.organizationId,
            userId,
            projectId: project.id,
            // Same environment identity the `in` proxy injects.
            environmentId: runtimeEnv.id,
            ...environmentAddress,
            ...(repoSnapshot ? { repoSnapshot } : {}),
          }
        : undefined;

      await createChat(dashboardAgentDb, {
        id: chatId,
        organizationId: project.organizationId,
        userId,
        ...(clientData ? { metadata: { context: clientContext } } : {}),
      });

      try {
        if (headStartMetadata) {
          // Injects the delegated token and context into the run's payload server-side.
          await startDashboardAgentHeadStart({
            chatId,
            messages: [firstMessage],
            mode: repoSnapshot ? "code" : "assistant",
            metadata: headStartMetadata,
          });
        } else {
          // Cold start: the client sends the first message through the `in` proxy, which
          // injects the token.
          // Same server-owned identity the head-start path injects; the `in` proxy adds the
          // delegated token on the first turn.
          await startDashboardAgentSession({
            chatId,
            clientData: {
              ...clientContext,
              organizationId: project.organizationId,
              userId,
              projectId: project.id,
              environmentId: runtimeEnv.id,
              ...environmentAddress,
            },
          });
        }
      } catch (error) {
        // Both starts are one create-session-and-trigger round trip, so a rejection means no
        // handover was dispatched and no message was sent: a session the call did create in
        // spite of the error idles out having done nothing. The empty row is all there is to undo.
        // Swallowed so the start's own error is what surfaces and gets logged.
        await softDeleteChat(dashboardAgentDb, {
          chatId,
          userId,
          organizationId: project.organizationId,
        }).catch((cleanupError) => {
          logger.error("Failed to remove a dashboard agent chat whose start failed", {
            chatId,
            error: cleanupError,
          });
        });
        throw error;
      }

      // Only the head start dispatches the first message here; a cold start sends it through
      // the `in` proxy, which counts it there. Counting both would double-count.
      if (headStarted) {
        await recordAgentMessageSent(dashboardAgentDb, {
          organizationId: project.organizationId,
        });
      }

      let publicAccessToken: string;
      try {
        publicAccessToken = await mintDashboardAgentToken(chatId);
      } catch (error) {
        // The start resolved, so the session is live and a head start is already streaming into
        // it. Deleting the chat here would hide a running agent; the client can ask for a token
        // again through the `token` intent.
        logger.error("Dashboard agent chat started but its token mint failed", { chatId, error });
        return json(
          { error: "The dashboard agent started but couldn't be opened. Try opening it again." },
          { status: 500 }
        );
      }
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

    const repository = await findRepositoryForSourceUris(project.id, [uri]);

    const resolved = resolveTriggerUri({ ...environment, repository }, uri);
    if (!resolved) return json({ error: "Nothing to open for that link" }, { status: 404 });

    return json({
      path: resolved.url,
      label: resolved.label,
      external: resolved.external ?? false,
    });
  }

  // The card's citations in one request: one environment lookup and one repo lookup for the
  // whole batch, same environment scope as `resolve`.
  if (parsed.data.intent === "resolve-many") {
    let uris: string[];
    try {
      const list = JSON.parse(parsed.data.uris ?? "") as unknown;
      if (!Array.isArray(list) || list.some((uri) => typeof uri !== "string")) {
        return json({ error: "uris is required" }, { status: 400 });
      }
      uris = [...new Set(list as string[])];
    } catch {
      return json({ error: "uris is required" }, { status: 400 });
    }

    if (uris.length === 0) return json({ error: "uris is required" }, { status: 400 });
    if (uris.length > MAX_URIS_PER_RESOLVE_REQUEST) {
      return json({ error: "Too many links in one request" }, { status: 400 });
    }

    const environment = await findEnvironmentBySlug(project.id, envParam, userId);
    if (!environment) return json({ error: "Environment not found" }, { status: 404 });

    const repository = await findRepositoryForSourceUris(project.id, uris);
    const scope = { ...environment, repository };

    // A null entry is the definitive "nothing to open": the client caches it.
    const resolved: Record<string, { path: string; label: string; external: boolean } | null> = {};
    for (const uri of uris) {
      const hit = resolveTriggerUri(scope, uri);
      resolved[uri] = hit
        ? { path: hit.url, label: hit.label, external: hit.external ?? false }
        : null;
    }

    return json({ resolved });
  }

  // The configuration card's submit path. The environment comes from the URL and goes
  // through the same re-authorization a background tick passes, never from the body.
  if (parsed.data.intent === "watch-create") {
    // No fallback: a per-condition key would identify the condition rather than this
    // submit, so a re-watch could replay a stale terminal outcome.
    const clientRequestId = parsed.data.clientRequestId;
    if (!clientRequestId) {
      return json({ error: "That watch isn't valid.", code: "invalid_request" }, { status: 400 });
    }

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
    const targetChatId = parsed.data.chatId;
    if (
      targetChatId &&
      !(await chatExists(dashboardAgentDb, {
        chatId: targetChatId,
        userId,
        organizationId: project.organizationId,
      }))
    ) {
      return json({ error: "Chat not found", code: "chat_not_found" }, { status: 404 });
    }

    // The request record is written before the watch and the confirmation after, so a
    // half-finished submit is repairable and never leaves a watch nobody can see.
    const result = await submitDashboardAgentWatch({
      environment,
      userId,
      organizationId: project.organizationId,
      chatId: targetChatId,
      clientRequestId,
      draft,
    });

    if (!result.ok) {
      return json(
        {
          error: result.error,
          code: result.code,
          ...(result.existingId ? { existingId: result.existingId } : {}),
        },
        { status: watchErrorStatus(result.code) }
      );
    }

    return json({
      chatId: result.chatId,
      watching: result.watching,
      watchId: result.watchId,
      messages: result.messages,
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
      const runtimeEnv = await findEnvironmentBySlug(project.id, envParam, userId);
      if (!runtimeEnv) return json({ error: "Environment not found" }, { status: 404 });

      try {
        // Whitelisted like `create` and the `in` proxy: this object lands in the resumed
        // run's `basePayload.metadata` verbatim, so without the pick a client could inject
        // any server-owned field into the agent's first turn (a `repoSnapshot.tarballUrl`
        // is fetched and extracted on the worker).
        const { publicAccessToken } = await startDashboardAgentSession({
          chatId,
          clientData: {
            ...pickAgentClientMetadata(clientData),
            organizationId: project.organizationId,
            userId,
            projectId: project.id,
            environmentId: runtimeEnv.id,
            ...dashboardAgentEnvironmentAddress(runtimeEnv),
          },
        });
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
      // Existence check gives a 404 for a chat this caller can't see; the delete itself
      // is org- and owner-scoped too, and ends the chat's watches in the same transaction.
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
      const { cancelledWatches } = await deleteChatWithWatches({
        chatId,
        userId,
        organizationId: project.organizationId,
      });
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

      // Only an active row is cancelled, so an already-resolved watch keeps its outcome,
      // this is a no-op and no note is written.
      const { messages } = await cancelDashboardAgentWatch({
        watchId,
        userId,
        organizationId: project.organizationId,
      });
      return json({ ok: true, messages });
    }
  }
};
