import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import {
  cancelWatch,
  chatExists,
  countUnreadWatchWakes,
  createChat,
  getChatMessages,
  getSession,
  getWatch,
  listChatIdsWithOpenInvestigations,
  listChatIdsWithUnreadWakes,
  listChats,
  listUnreadWatchWakes,
  markChatRead,
  renameChat,
  setChatPinned,
  softDeleteChat,
} from "@internal/dashboard-agent-db";
import { watchSpecSchema, type WatchSpec } from "@internal/dashboard-agent-contracts";
import { generateFriendlyId } from "@trigger.dev/core/v3/isomorphic";
import type { UIMessage } from "ai";
import { z } from "zod";
import { $replica } from "~/db.server";
import { env } from "~/env.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import {
  cancelWatchesForDeletedChat,
  createDashboardAgentWatch,
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
    "watch",
    "watch-cancel",
  ]),
  // Omitted for `create` (the server generates it); required for the rest.
  chatId: z.string().min(1).optional(),
  // The first user message (JSON UIMessage), for `create`.
  message: z.string().optional(),
  clientData: z.string().optional(),
  title: z.string().optional(),
  pinned: z.enum(["true", "false"]).optional(),
  // A JSON WatchSpec, for `watch`.
  spec: z.string().optional(),
  // The watch to cancel, for `watch-cancel`.
  watchId: z.string().min(1).optional(),
});

// History list, or — with ?chatId= — the stored transcript + session for resume,
// or — with ?unread=1 — just the unread wake count plus the capped list of those
// wakes (the launcher's dot and the wake toast poll it while the panel is closed,
// so it must stay cheap).
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

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) return json({ error: "Project not found" }, { status: 404 });

  const searchParams = new URL(request.url).searchParams;

  if (searchParams.get("unread") === "1") {
    // The count drives the dot, the capped list drives one toast per wake.
    const [unreadWakes, wakes] = await Promise.all([
      countUnreadWatchWakes(dashboardAgentDb, {
        organizationId: project.organizationId,
        userId,
      }),
      listUnreadWatchWakes(dashboardAgentDb, {
        organizationId: project.organizationId,
        userId,
      }),
    ]);
    return json({ unreadWakes, wakes });
  }

  const chatId = searchParams.get("chatId");
  if (chatId) {
    const [messages, session] = await Promise.all([
      getChatMessages(dashboardAgentDb, { chatId, userId }),
      getSession(dashboardAgentDb, { chatId, userId }),
    ]);
    return json({ messages: messages ?? [], session });
  }

  const chats = await listChats(dashboardAgentDb, {
    organizationId: project.organizationId,
    userId,
  });

  // Active-watch chips for the list, which chats woke unseen, and which are
  // mid-investigation — one query each for ALL the listed chats, because the
  // history list must not fan out a query per row.
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
        // Both are row markers in the history list: the chat has something
        // running in it. Derived here so the list doesn't re-derive per render.
        // The list now carries fired/expired watches too (the wake banner needs
        // their kind), so "something is running" means active specifically.
        hasActiveWatch: watches.some((watch) => watch.status === "active"),
        hasOpenInvestigation: investigatingChatIds.has(chat.id),
      };
    }),
    unreadWakes,
  });
};

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

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) return json({ error: "Project not found" }, { status: 404 });

  const parsed = ActionBody.safeParse(Object.fromEntries(await request.formData()));
  if (!parsed.success) return json({ error: "Invalid request" }, { status: 400 });

  // Create a new chat: the SERVER generates the id and owns the chat record, so
  // a client can never name another user's chat. Kicks off the first turn (head
  // start when configured, else a cold session) and returns the id + token. The
  // client mounts with that id and resumes the stream.
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
        // Head start runs the warm step-1 with this first message and injects the
        // delegated token + context into the run's payload server-side.
        await startDashboardAgentHeadStart({
          chatId,
          messages: [firstMessage],
          mode: repoSnapshot ? "code" : "assistant",
          metadata: {
            // The agent validates the run metadata against its clientDataSchema
            // (userId, organizationId, …), so the per-turn clientData has to be
            // present alongside the injected auth/context fields.
            ...(clientData ?? {}),
            userActorToken: await mintDashboardAgentUserActorToken(userId),
            apiOrigin: dashboardAgentApiOrigin(),
            projectRef: project.externalRef,
            // Same canonical environment identity the `in` proxy injects, so turn
            // 1 and turn N carry identical context.
            environmentId: runtimeEnv?.id,
            environmentName,
            ...(repoSnapshot ? { repoSnapshot } : {}),
          },
        });
      } else {
        // Cold start: create the session (preload); the client sends the first
        // message through the transport, where the `in` proxy injects the token.
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

  const { intent, chatId } = parsed.data;
  if (!chatId) return json({ error: "chatId is required" }, { status: 400 });

  switch (intent) {
    case "start": {
      if (!isDashboardAgentConfigured()) {
        return json({ error: "The dashboard agent is not configured." }, { status: 501 });
      }
      // Resume-only: new chats are created via the `create` intent (server-owned
      // id). The transport falls back here to re-establish a session for an
      // existing chat (e.g. after its token expired), so verify ownership before
      // issuing one — a client-supplied chatId must belong to the caller.
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
      // Only mint a session token for a chat the caller owns, so a client-supplied
      // chatId can't be used to get a token for someone else's session.
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
      await renameChat(dashboardAgentDb, { chatId, userId, title: parsed.data.title });
      return json({ ok: true });
    }

    case "pin": {
      await setChatPinned(dashboardAgentDb, {
        chatId,
        userId,
        pinned: parsed.data.pinned === "true",
      });
      return json({ ok: true });
    }

    // The user has this chat in front of them, so its watch wakes are seen. The
    // update is owner-scoped, so a chatId the caller doesn't own is a no-op.
    case "read": {
      await markChatRead(dashboardAgentDb, { chatId, userId });
      return json({ ok: true });
    }

    case "delete": {
      // Ownership first: the watch cascade is keyed on chatId alone, so a chatId
      // the caller doesn't own must not reach it.
      if (
        !(await chatExists(dashboardAgentDb, {
          chatId,
          userId,
          organizationId: project.organizationId,
        }))
      ) {
        return json({ error: "Chat not found" }, { status: 404 });
      }
      await softDeleteChat(dashboardAgentDb, { chatId, userId });
      // A deleted chat has nowhere to deliver a watch outcome, so its watches end
      // with it.
      const cancelledWatches = await cancelWatchesForDeletedChat(chatId);
      return json({ ok: true, cancelledWatches });
    }

    // Schedule a watch from the panel, under the user's own session. Same service
    // the agent's UAT endpoint calls; project/env come from the URL and are
    // authorized through the dashboard's own environment lookup.
    case "watch": {
      if (!parsed.data.spec) return json({ error: "spec is required" }, { status: 400 });

      let spec: WatchSpec;
      try {
        const result = watchSpecSchema.safeParse(JSON.parse(parsed.data.spec));
        if (!result.success) return json({ error: "Invalid watch spec" }, { status: 400 });
        spec = result.data;
      } catch {
        return json({ error: "Invalid watch spec" }, { status: 400 });
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

      const environment = await findEnvironmentBySlug(project.id, envParam, userId);
      if (!environment) return json({ error: "Environment not found" }, { status: 404 });

      const result = await createDashboardAgentWatch({ environment, userId, chatId, spec });
      if (!result.ok) {
        return json(
          {
            error: result.error,
            code: result.code,
            ...(result.existingId ? { existingId: result.existingId } : {}),
          },
          {
            // Same codes the agent's endpoint uses, so the UI can share the copy.
            status:
              result.code === "limit_reached" || result.code === "duplicate"
                ? 409
                : result.code === "not_configured"
                  ? 501
                  : 400,
          }
        );
      }

      return json({
        watchId: result.watchId,
        identity: result.identity,
        status: result.status,
        expiresAt: result.expiresAt.toISOString(),
        ...(result.immediate ? { immediate: result.immediate } : {}),
      });
    }

    // Stop watching, from the chip's ×. Ownership goes through the chat: the watch
    // must belong to the chat named in the request, and that chat must belong to
    // this user in this org — so a watch id alone can never cancel someone else's
    // watch.
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

      // A watch that already fired or expired keeps its outcome — `cancelWatch`
      // only touches an active row, so this is a no-op then, not an error.
      await cancelWatch(dashboardAgentDb, { id: watchId, reason: "user" });
      return json({ ok: true });
    }
  }
};
