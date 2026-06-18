import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import {
  createChat,
  getChatMessages,
  getSession,
  listChats,
  renameChat,
  setChatPinned,
  softDeleteChat,
} from "@internal/dashboard-agent-db";
import { z } from "zod";
import { findProjectBySlug } from "~/models/project.server";
import {
  isDashboardAgentConfigured,
  mintDashboardAgentToken,
  startDashboardAgentSession,
} from "~/services/dashboardAgent.server";
import { dashboardAgentDb } from "~/services/dashboardAgentDb.server";
import { logger } from "~/services/logger.server";
import { requireUser } from "~/services/session.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";
import { canAccessDashboardAgent } from "~/v3/canAccessDashboardAgent.server";

const ActionBody = z.object({
  intent: z.enum(["start", "token", "rename", "pin", "delete"]),
  chatId: z.string().min(1),
  clientData: z.string().optional(),
  title: z.string().optional(),
  pinned: z.enum(["true", "false"]).optional(),
});

// History list, or — with ?chatId= — the stored transcript + session for resume.
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const user = await requireUser(request);
  const userId = user.id;
  const { organizationSlug, projectParam } = EnvironmentParamSchema.parse(params);

  if (!(await canAccessDashboardAgent({ userId, isAdmin: user.admin, isImpersonating: user.isImpersonating, organizationSlug }))) {
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
  const { organizationSlug, projectParam } = EnvironmentParamSchema.parse(params);

  if (!(await canAccessDashboardAgent({ userId, isAdmin: user.admin, isImpersonating: user.isImpersonating, organizationSlug }))) {
    return json({ error: "Not found" }, { status: 404 });
  }

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) return json({ error: "Project not found" }, { status: 404 });

  const parsed = ActionBody.safeParse(Object.fromEntries(await request.formData()));
  if (!parsed.success) return json({ error: "Invalid request" }, { status: 400 });

  const { intent, chatId } = parsed.data;

  switch (intent) {
    case "start": {
      if (!isDashboardAgentConfigured()) {
        return json({ error: "The dashboard agent is not configured." }, { status: 501 });
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
        // Show the chat in History before the agent's own onChatStart ensure.
        await createChat(dashboardAgentDb, {
          id: chatId,
          organizationId: project.organizationId,
          userId,
          ...(clientData ? { metadata: { context: clientData } } : {}),
        });
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
