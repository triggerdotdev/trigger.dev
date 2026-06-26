import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import {
  chatExists,
  createChat,
  getChatMessages,
  getSession,
  listChats,
  renameChat,
  setChatPinned,
  softDeleteChat,
} from "@internal/dashboard-agent-db";
import { generateFriendlyId } from "@trigger.dev/core/v3/isomorphic";
import type { UIMessage } from "ai";
import { z } from "zod";
import { $replica } from "~/db.server";
import { env } from "~/env.server";
import { findProjectBySlug } from "~/models/project.server";
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
  intent: z.enum(["start", "create", "token", "rename", "pin", "delete"]),
  // Omitted for `create` (the server generates it); required for the rest.
  chatId: z.string().min(1).optional(),
  // The first user message (JSON UIMessage), for `create`.
  message: z.string().optional(),
  clientData: z.string().optional(),
  title: z.string().optional(),
  pinned: z.enum(["true", "false"]).optional(),
});

// History list, or — with ?chatId= — the stored transcript + session for resume.
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

  const chatId = new URL(request.url).searchParams.get("chatId");
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
  return json({ chats });
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
        select: { type: true },
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

    case "delete": {
      await softDeleteChat(dashboardAgentDb, { chatId, userId });
      return json({ ok: true });
    }
  }
};
