import type { ActionFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { auth } from "@trigger.dev/sdk";
import { chat } from "@trigger.dev/sdk/ai";
import { requireUserId } from "~/services/session.server";
import { withAssistantAuth, type AssistantEnvContext } from "~/services/aiAssistant.server";

const startDashboardAssistant = chat.createStartSessionAction("dashboard-assistant");

// Auth context from the server-trusted userId + the slugs the browser sends.
// The userId is never trusted from the browser — membership is re-checked
// against it in `withAssistantAuth`.
function envContext(
  userId: string,
  clientData: Record<string, unknown> | undefined
): AssistantEnvContext {
  return {
    userId,
    organizationSlug: String(clientData?.organizationSlug ?? ""),
    projectSlug: String(clientData?.projectSlug ?? ""),
    environmentSlug: String(clientData?.environmentSlug ?? ""),
  };
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const userId = await requireUserId(request);
  const body = (await request.json()) as {
    intent?: string;
    chatId?: string;
    clientData?: Record<string, unknown>;
  };

  if (!body.chatId) {
    return json({ error: "Missing chatId" }, { status: 400 });
  }
  const chatId = body.chatId;

  if (body.intent === "createSession") {
    const { clientData } = body;
    const ctx = envContext(userId, clientData);

    const result = await withAssistantAuth(ctx, () =>
      startDashboardAssistant({
        chatId,
        // Override the browser-claimed userId with the server-trusted one.
        clientData: { ...clientData, userId },
      })
    );

    return json({
      sessionId: result.sessionId,
      publicAccessToken: result.publicAccessToken,
    });
  }

  if (body.intent === "refreshToken") {
    const { chatId, clientData } = body;
    const ctx = envContext(userId, clientData);

    // Pure mint — no session create, no run trigger. Scoped to this chat.
    const publicAccessToken = await withAssistantAuth(ctx, () =>
      auth.createPublicToken({
        scopes: {
          read: { sessions: chatId },
          write: { sessions: chatId },
        },
      })
    );

    return json({ publicAccessToken });
  }

  return json({ error: "Unknown intent" }, { status: 400 });
};
