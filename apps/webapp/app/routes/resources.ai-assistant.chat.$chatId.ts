import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { prisma } from "~/db.server";
import { requireUserId } from "~/services/session.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { chatId } = params;

  if (!chatId) {
    return json({ error: "Missing chatId" }, { status: 400 });
  }

  const [chat, session] = await Promise.all([
    prisma.aiChat.findFirst({
      where: { id: chatId, userId },
      select: {
        id: true,
        title: true,
        messages: true,
        model: true,
      },
    }),
    prisma.aiChatSession.findFirst({
      where: { id: chatId },
      select: {
        publicAccessToken: true,
        lastEventId: true,
      },
    }),
  ]);

  if (!chat) {
    return json({ error: "Chat not found" }, { status: 404 });
  }

  return json({
    chat,
    session: session
      ? {
          publicAccessToken: session.publicAccessToken,
          lastEventId: session.lastEventId,
        }
      : null,
  });
};
