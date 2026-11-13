import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import {
  appendChatMessageOnceByChatId,
  chatExists,
  countChatsWithUnreadWork,
  ALERT_CREATION_CHAT_TITLE,
  createChat,
  getChatMessages,
  getChatScope,
  getSession,
  listChatIdsWithOpenInvestigations,
  listChats,
  markChatRead,
  renameChat,
  setChatPinned,
  softDeleteChat,
} from "@internal/dashboard-agent-db";
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
import { alertCreationOpeningMessage } from "~/components/alerts/alertCreatedCard";
import { MAX_URIS_PER_RESOLVE_REQUEST } from "~/components/dashboard-agent/resolve-uris";
import { $replica } from "~/db.server";
import { env } from "~/env.server";
import { findProjectWithOrgFlagsBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import {
  dashboardAgentUserApiOrigin,
  dashboardAgentWakeFeedCounter,
  isDashboardAgentConfigured,
  mintDashboardAgentToken,
  mintDashboardAgentUserActorToken,
  resolveDashboardAgentRepoSnapshot,
  startDashboardAgentSession,
} from "~/services/dashboardAgent.server";
import { dashboardAgentTags } from "~/services/dashboardAgentTags";
import { dashboardAgentEnvironmentAddress } from "~/services/dashboardAgentEnvironmentAddress.server";
import { wellFormMessageText } from "~/services/dashboardAgentMessageText.server";
import { startDashboardAgentHeadStart } from "~/services/dashboardAgentHeadStart.server";
import { dashboardAgentDb } from "~/services/dashboardAgentDb.server";
import {
  isDashboardAgentQuotaEnabled,
  recordAgentMessageSent,
  resolveAgentMessageQuota,
  UNLIMITED_AGENT_MESSAGES,
} from "~/services/dashboardAgentQuota.server";
import { logger } from "~/services/logger.server";
import { resolveTriggerUrisInOrganization } from "~/services/resolveTriggerUriInOrganization.server";
import { getImpersonatorUserId, requireUser } from "~/services/session.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";
import { canAccessDashboardAgent } from "~/v3/canAccessDashboardAgent.server";
import { canUseAlertsList } from "~/v3/canUseAlertsList.server";
// The client-metadata whitelist lives with the `in` proxy, the other mint site, so the two cannot
// drift apart.
import {
  pickAgentClientMetadata,
  withChatScope,
} from "./resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.dashboard-agent.in.$";

const ActionBody = z.object({
  intent: z.enum([
    "start",
    "create",
    "create-session",
    "token",
    "rename",
    "pin",
    "delete",
    "read",
    "resolve",
    "resolve-many",
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
});

// History list by default. `?chatId=` returns the stored transcript plus session,
// `?unread=1` the unread work count, `?quota=1` the message count.
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const user = await requireUser(request);
  const userId = user.id;
  const actingUserId = user.isImpersonating ? await getImpersonatorUserId(request) : undefined;
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

  // The unread poll runs once a minute per open tab, so it reads only the org id it needs
  // and asks the agent DB one question.
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

    // The poll is where a closed panel learns about unread work.
    const unreadWork = await countChatsWithUnreadWork(dashboardAgentDb, {
      organizationId: scoped.organizationId,
      userId,
      actingUserId,
      // The chat the panel has on screen, if any: it is being read as this is counted.
      excludeChatId: searchParams.get("chatId") ?? undefined,
    });

    return json({ unreadWork });
  }

  const project = await findProjectWithOrgFlagsBySlug(organizationSlug, projectParam, userId);
  if (!project) return json({ error: "Project not found" }, { status: 404 });

  // The per-period counter, org-wide: a deleted chat can't lower it within the period.
  if (searchParams.get("quota") === "1") {
    // Free for now: tell a mounted client explicitly, so it drops any cached used/limit
    // and cap-reached state from before the switch flipped off, instead of keeping it
    // until remount (a `{}` body would silently ignore and keep the stale state).
    if (!isDashboardAgentQuotaEnabled() || actingUserId) return json({ enabled: false });

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
      getChatMessages(dashboardAgentDb, {
        chatId,
        userId,
        actingUserId,
        organizationId: project.organizationId,
      }),
      getSession(dashboardAgentDb, {
        chatId,
        userId,
        actingUserId,
        organizationId: project.organizationId,
      }),
    ]);
    // Null is not an empty transcript: the chat is deleted or another org's, and a 200 would
    // read as a real, empty chat.
    if (messages === null) return json({ error: "Chat not found" }, { status: 404 });
    // The stored token is the agent run's own (bare `read:sessions` plus run scopes), kept for
    // the agent's replay. The browser gets a token minted for it, narrowed like every other
    // dashboard-agent issuance; a failed mint degrades to a non-streaming transcript.
    let browserSession: typeof session = null;
    if (session && isDashboardAgentConfigured()) {
      try {
        browserSession = { ...session, publicAccessToken: await mintDashboardAgentToken(chatId) };
      } catch (error) {
        if (error instanceof Response) throw error;
        logger.error("Dashboard agent chat read could not mint a browser token", {
          chatId,
          error,
          organizationSlug,
        });
      }
    }
    return json({ messages, session: browserSession });
  }

  const chats = await listChats(dashboardAgentDb, {
    organizationId: project.organizationId,
    userId,
    actingUserId,
    withMessagesOnly: true,
  });

  // One query for all the listed chats, never one per row.
  const investigatingChatIds = await listChatIdsWithOpenInvestigations(dashboardAgentDb, {
    organizationId: project.organizationId,
    userId,
    actingUserId,
  });

  return json({
    chats: chats.map((chat) => ({
      ...chat,
      // Work that finished while the chat was closed: the transcript moved on after the
      // last time its owner looked.
      hasUnreadWork:
        chat.lastMessageAt !== null &&
        (chat.lastReadAt === null || chat.lastMessageAt > chat.lastReadAt),
      hasOpenInvestigation: investigatingChatIds.has(chat.id),
    })),
  });
};

function messageTooLarge() {
  return json({ error: MESSAGE_TOO_LARGE_ERROR, code: MESSAGE_TOO_LARGE_CODE }, { status: 413 });
}

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const user = await requireUser(request);
  const userId = user.id;
  const actingUserId = user.isImpersonating ? await getImpersonatorUserId(request) : undefined;
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

  const project = await findProjectWithOrgFlagsBySlug(organizationSlug, projectParam, userId);
  if (!project) return json({ error: "Project not found" }, { status: 404 });
  const orgFeatureFlags = (project.organization.featureFlags as Record<string, unknown>) ?? {};

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

    const quota = actingUserId
      ? null
      : await resolveAgentMessageQuota(dashboardAgentDb, {
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
    // Server-resolved, never sent by the browser.
    const alertsEnabled =
      !actingUserId &&
      (await canUseAlertsList({
        userId,
        orgFeatureFlags,
      }));

    // Membership-scoped: dev rows are per-developer, so a token must never be minted for
    // someone else's environment — or, when nothing resolves, for no environment at all.
    const runtimeEnv = await findEnvironmentBySlug(project.id, envParam, userId);
    if (!runtimeEnv) return json({ error: "Environment not found" }, { status: 404 });
    const environmentAddress = dashboardAgentEnvironmentAddress(runtimeEnv);
    const tags = dashboardAgentTags({
      organizationSlug,
      projectRef: project.externalRef,
      environmentSlug: runtimeEnv.slug,
      userId,
    });

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
            alertsEnabled,
            userActorToken: await mintDashboardAgentUserActorToken(userId, {
              environmentId: runtimeEnv.id,
              ...(alertsEnabled ? { alertWrites: { request } } : {}),
            }),
            apiOrigin: dashboardAgentUserApiOrigin(),
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
        ...(actingUserId ? { createdByUserId: actingUserId } : {}),
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
            alertsEnabled,
            tags,
          });
        } else {
          // Cold start: the client sends the first message through the `in` proxy, which
          // injects the token.
          // Same server-owned identity the head-start path injects; the `in` proxy adds the
          // delegated token on the first turn.
          await startDashboardAgentSession({
            chatId,
            tags,
            clientData: {
              ...clientContext,
              alertsEnabled,
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
          actingUserId,
          organizationId: project.organizationId,
        }).catch((cleanupError) => {
          logger.error("Failed to remove a dashboard agent chat whose start failed", {
            chatId,
            error: cleanupError,
            organizationSlug,
          });
        });
        throw error;
      }

      // Only the head start dispatches the first message here; a cold start sends it through
      // the `in` proxy, which counts it there. Counting both would double-count.
      if (headStarted && !actingUserId) {
        await recordAgentMessageSent(dashboardAgentDb, {
          organizationId: project.organizationId,
        });
      }

      let publicAccessToken: string;
      try {
        publicAccessToken = await mintDashboardAgentToken(chatId);
      } catch (error) {
        if (error instanceof Response) throw error;
        // The start resolved, so the session is live and a head start is already streaming into
        // it. Deleting the chat here would hide a running agent; the client can ask for a token
        // again through the `token` intent.
        logger.error("Dashboard agent chat started but its token mint failed", {
          chatId,
          error,
          organizationSlug,
        });
        return json(
          { error: "The dashboard agent started but couldn't be opened. Try opening it again." },
          { status: 500 }
        );
      }
      return json({ chatId, publicAccessToken, headStarted });
    } catch (error) {
      if (error instanceof Response) throw error;
      logger.error("Failed to create dashboard agent chat", { chatId, error, organizationSlug });
      return json(
        { error: "The dashboard agent couldn't start. Please try again in a moment." },
        { status: 500 }
      );
    }
  }

  if (parsed.data.intent === "create-session") {
    if (!isDashboardAgentConfigured()) {
      return json({ error: "The dashboard agent is not configured." }, { status: 501 });
    }

    const quota = await resolveAgentMessageQuota(dashboardAgentDb, {
      organizationId: project.organizationId,
    });
    if (quota?.reached) {
      return json({ error: MESSAGE_QUOTA_REACHED_ERROR, limit: quota.limit }, { status: 403 });
    }

    const chatId = generateFriendlyId("chat");
    try {
      await createChat(dashboardAgentDb, {
        id: chatId,
        organizationId: project.organizationId,
        userId,
        kind: "alert_creation",
        title: ALERT_CREATION_CHAT_TITLE,
      });
      await appendCreationOpening({
        chatId,
        userId,
        actingUserId,
        organizationId: project.organizationId,
      });

      return json({ chatId, headStarted: false });
    } catch (error) {
      if (error instanceof Response) throw error;
      logger.error("Failed to create dashboard agent session", {
        chatId,
        error,
        organizationSlug,
      });
      return json({ error: "Couldn't create the session. Please try again." }, { status: 500 });
    }
  }

  // Scoped by the organization, not by the environment in the URL: the agent reads across the
  // organization's projects, so a citation resolves against its own project and environment.
  if (parsed.data.intent === "resolve") {
    const uri = parsed.data.uri;
    if (!uri) return json({ error: "uri is required" }, { status: 400 });

    const resolved = (
      await resolveTriggerUrisInOrganization({ userId, organizationId: project.organizationId }, [
        uri,
      ])
    ).get(uri);
    if (!resolved) return json({ error: "Nothing to open for that link" }, { status: 404 });

    return json({
      path: resolved.url,
      label: resolved.label,
      external: resolved.external ?? false,
    });
  }

  // The card's citations in one request: one environment lookup and one repo lookup for the
  // whole batch, same organization scope as `resolve`.
  if (parsed.data.intent === "resolve-many") {
    let uris: string[];
    try {
      const list = JSON.parse(parsed.data.uris ?? "") as unknown;
      if (!Array.isArray(list) || list.some((uri) => typeof uri !== "string")) {
        return json({ error: "uris is required" }, { status: 400 });
      }
      uris = [...new Set(list as string[])];
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return json({ error: "uris is required" }, { status: 400 });
    }

    if (uris.length === 0) return json({ error: "uris is required" }, { status: 400 });
    if (uris.length > MAX_URIS_PER_RESOLVE_REQUEST) {
      return json({ error: "Too many links in one request" }, { status: 400 });
    }

    const hits = await resolveTriggerUrisInOrganization(
      { userId, organizationId: project.organizationId },
      uris
    );

    // A null entry is the definitive "nothing to open": the client caches it.
    const resolved: Record<string, { path: string; label: string; external: boolean } | null> = {};
    for (const uri of uris) {
      const hit = hits.get(uri);
      resolved[uri] = hit
        ? { path: hit.url, label: hit.label, external: hit.external ?? false }
        : null;
    }

    return json({ resolved });
  }

  const { intent, chatId } = parsed.data;
  if (!chatId) return json({ error: "chatId is required" }, { status: 400 });

  switch (intent) {
    case "start": {
      if (!isDashboardAgentConfigured()) {
        return json({ error: "The dashboard agent is not configured." }, { status: 501 });
      }
      // Resume only, so a client-supplied chatId is checked against the caller first.
      const chat = await getChatScope(dashboardAgentDb, {
        chatId,
        userId,
        actingUserId,
        organizationId: project.organizationId,
      });
      if (!chat) return json({ error: "Chat not found" }, { status: 404 });
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
        await startDashboardAgentSession({
          chatId,
          tags: dashboardAgentTags({
            organizationSlug,
            projectRef: project.externalRef,
            environmentSlug: runtimeEnv.slug,
            userId,
          }),
          clientData: {
            ...withChatScope(pickAgentClientMetadata(clientData), chat),
            alertsEnabled:
              !actingUserId &&
              (await canUseAlertsList({
                userId,
                orgFeatureFlags,
              })),
            organizationId: project.organizationId,
            userId,
            projectId: project.id,
            environmentId: runtimeEnv.id,
            ...dashboardAgentEnvironmentAddress(runtimeEnv),
          },
        });
      } catch (error) {
        if (error instanceof Response) throw error;
        logger.error("Failed to start dashboard agent session", {
          chatId,
          error,
          organizationSlug,
        });
        return json(
          { error: "The dashboard agent couldn't start. Please try again in a moment." },
          { status: 500 }
        );
      }

      try {
        return json({ publicAccessToken: await mintDashboardAgentToken(chatId) });
      } catch (error) {
        if (error instanceof Response) throw error;
        // The session is live and idles out on its own if the client never comes back.
        logger.error("Dashboard agent chat resumed but its token mint failed", {
          chatId,
          error,
          organizationSlug,
        });
        return json(
          { error: "The dashboard agent started but couldn't be opened. Try opening it again." },
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
          actingUserId,
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
        actingUserId,
        organizationId: project.organizationId,
        title: parsed.data.title,
      });
      return json({ ok: true });
    }

    case "pin": {
      await setChatPinned(dashboardAgentDb, {
        chatId,
        userId,
        actingUserId,
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
        actingUserId,
        organizationId: project.organizationId,
      });
      return json({ ok: true });
    }

    case "delete": {
      // Existence check gives a 404 for a chat this caller can't see; the delete itself
      // is org- and owner-scoped too.
      if (
        !(await chatExists(dashboardAgentDb, {
          chatId,
          userId,
          actingUserId,
          organizationId: project.organizationId,
        }))
      ) {
        return json({ error: "Chat not found" }, { status: 404 });
      }
      await softDeleteChat(dashboardAgentDb, {
        chatId,
        userId,
        actingUserId,
        organizationId: project.organizationId,
      });
      return json({ ok: true });
    }
  }
};

async function appendCreationOpening(params: {
  chatId: string;
  userId: string;
  actingUserId?: string;
  organizationId: string;
}) {
  const { chatId } = params;
  try {
    await appendChatMessageOnceByChatId(dashboardAgentDb, {
      chatId,
      message: alertCreationOpeningMessage(chatId),
    });
    await markChatRead(dashboardAgentDb, params);
  } catch (error) {
    logger.error("Failed to append the alert creation opening message", { chatId, error });
  }
}
