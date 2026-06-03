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
  const orgSlug = String(clientData?.organizationSlug ?? "").trim();
  const projSlug = String(clientData?.projectSlug ?? "").trim();
  const envSlug = String(clientData?.environmentSlug ?? "").trim();

  if (!orgSlug || !projSlug || !envSlug) {
    throw new Error("Missing organization, project, or environment slug");
  }

  return {
    userId,
    organizationSlug: orgSlug,
    projectSlug: projSlug,
    environmentSlug: envSlug,
  };
}

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
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
          clientData: {
            userId,
            organizationSlug: ctx.organizationSlug,
            projectSlug: ctx.projectSlug,
            environmentSlug: ctx.environmentSlug,
            currentPage: String(clientData?.currentPage ?? ""),
            currentParams: clientData?.currentParams
              ? (clientData.currentParams as Record<string, string>)
              : undefined,
          },
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json(
      { error: `AI assistant error: ${message}` },
      { status: 500 }
    );
  }
};
