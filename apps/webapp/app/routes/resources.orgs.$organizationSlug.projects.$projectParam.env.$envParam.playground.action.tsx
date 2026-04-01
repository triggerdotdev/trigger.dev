import { json } from "@remix-run/server-runtime";
import { type ActionFunctionArgs } from "@remix-run/server-runtime";
import {
  generateJWT as internal_generateJWT,
} from "@trigger.dev/core/v3";
import { z } from "zod";
import { prisma } from "~/db.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";
import { TriggerTaskService } from "~/v3/services/triggerTask.server";
import { extractJwtSigningSecretKey } from "~/services/realtime/jwtAuth.server";

const PlaygroundAction = z.object({
  intent: z.enum(["create", "trigger", "renew", "save", "delete"]),
  agentSlug: z.string(),
  // For create
  conversationId: z.string().optional(),
  // For trigger
  chatId: z.string().optional(),
  payload: z.string().optional(),
  clientData: z.string().optional(),
  tags: z.string().optional(),
  machine: z.string().optional(),
  maxAttempts: z.string().optional(),
  maxDuration: z.string().optional(),
  version: z.string().optional(),
  region: z.string().optional(),
  // For renew
  runId: z.string().optional(),
  // For save
  messages: z.string().optional(),
  lastEventId: z.string().optional(),
  // For delete
  deleteConversationId: z.string().optional(),
});

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    return json({ error: "Project not found" }, { status: 404 });
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    return json({ error: "Environment not found" }, { status: 404 });
  }

  const formData = await request.formData();
  const parsed = PlaygroundAction.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return json({ error: "Invalid request", details: parsed.error.issues }, { status: 400 });
  }

  const { intent } = parsed.data;

  switch (intent) {
    case "create": {
      const { agentSlug } = parsed.data;
      const chatId = crypto.randomUUID();

      const conversation = await prisma.playgroundConversation.create({
        data: {
          chatId,
          agentSlug,
          projectId: project.id,
          runtimeEnvironmentId: environment.id,
          userId,
        },
      });

      return json({
        conversationId: conversation.id,
        chatId,
      });
    }

    case "trigger": {
      const {
        agentSlug,
        chatId,
        payload: payloadStr,
        clientData,
        tags: tagsStr,
        machine,
        maxAttempts,
        maxDuration,
        version,
        region,
      } = parsed.data;

      if (!payloadStr || !chatId) {
        return json({ error: "payload and chatId are required" }, { status: 400 });
      }

      const payload = JSON.parse(payloadStr) as Record<string, any>;

      const triggerService = new TriggerTaskService();
      const result = await triggerService.call(
        agentSlug,
        environment,
        {
          payload,
          options: {
            payloadType: "application/json",
            test: true,
            tags: [
              `chat:${chatId}`,
              "playground:true",
              ...(tagsStr ? tagsStr.split(",").map((t) => t.trim()).filter(Boolean) : []),
            ].slice(0, 5),
            machine: machine as any,
            maxAttempts: maxAttempts ? parseInt(maxAttempts, 10) : undefined,
            maxDuration: maxDuration ? parseInt(maxDuration, 10) : undefined,
            lockToVersion: version && version !== "latest" ? version : undefined,
            region: region || undefined,
          },
        },
        { triggerSource: "dashboard", triggerAction: "test", realtimeStreamsVersion: "v2" }
      );

      if (!result?.run) {
        return json({ error: "Failed to trigger agent" }, { status: 500 });
      }

      // Create or update the playground conversation
      let parsedClientData: unknown;
      try {
        parsedClientData = clientData ? JSON.parse(clientData) : undefined;
      } catch {
        // Client data JSON was invalid — proceed without it
      }

      // Extract first message text for title
      const firstMessage = payload?.messages?.[0];
      const firstText =
        firstMessage?.parts?.find((p: any) => p.type === "text")?.text ?? "New conversation";
      const title = firstText.length > 60 ? firstText.slice(0, 60) + "..." : firstText;

      const conversation = await prisma.playgroundConversation.upsert({
        where: {
          chatId_runtimeEnvironmentId: {
            chatId,
            runtimeEnvironmentId: environment.id,
          },
        },
        create: {
          chatId,
          title,
          agentSlug,
          runId: result.run.id,
          clientData: parsedClientData as any,
          projectId: project.id,
          runtimeEnvironmentId: environment.id,
          userId,
        },
        update: {
          runId: result.run.id,
          clientData: parsedClientData as any,
          title,
        },
      });

      const jwt = await mintRunToken(environment, result.run.friendlyId);

      return json({
        runId: result.run.friendlyId,
        publicAccessToken: jwt,
        conversationId: conversation.id,
      });
    }

    case "renew": {
      const { runId } = parsed.data;
      if (!runId) {
        return json({ error: "runId is required" }, { status: 400 });
      }

      const jwt = await mintRunToken(environment, runId);
      return json({ publicAccessToken: jwt });
    }

    case "save": {
      const { chatId, messages: messagesStr, lastEventId } = parsed.data;
      if (!chatId) {
        return json({ error: "chatId is required" }, { status: 400 });
      }

      const messagesData = messagesStr ? JSON.parse(messagesStr) : undefined;

      // Extract title from the first user message if the conversation still has the default title.
      // This handles the case where a preloaded conversation gets its first real message
      // via the input stream (bypassing the trigger action that normally sets the title).
      let titleUpdate: { title: string } | undefined;
      if (messagesData && Array.isArray(messagesData)) {
        const existing = await prisma.playgroundConversation.findFirst({
          where: { chatId, runtimeEnvironmentId: environment.id },
          select: { title: true },
        });

        if (existing?.title === "New conversation") {
          const firstUserMsg = messagesData.find(
            (m: any) => m.role === "user"
          ) as Record<string, any> | undefined;
          const firstText =
            firstUserMsg?.parts?.find((p: any) => p.type === "text")?.text ??
            firstUserMsg?.content;
          if (firstText && typeof firstText === "string") {
            titleUpdate = {
              title: firstText.length > 60 ? firstText.slice(0, 60) + "..." : firstText,
            };
          }
        }
      }

      await prisma.playgroundConversation.updateMany({
        where: {
          chatId,
          runtimeEnvironmentId: environment.id,
        },
        data: {
          ...(messagesData ? { messages: messagesData as any } : {}),
          ...(lastEventId ? { lastEventId } : {}),
          ...titleUpdate,
        },
      });

      return json({ ok: true });
    }

    case "delete": {
      const { deleteConversationId } = parsed.data;
      if (!deleteConversationId) {
        return json({ error: "deleteConversationId is required" }, { status: 400 });
      }

      await prisma.playgroundConversation.deleteMany({
        where: {
          id: deleteConversationId,
          runtimeEnvironmentId: environment.id,
          userId,
        },
      });

      return json({ ok: true });
    }
  }
};

async function mintRunToken(
  environment: Parameters<typeof extractJwtSigningSecretKey>[0],
  runFriendlyId: string
): Promise<string> {
  return internal_generateJWT({
    secretKey: extractJwtSigningSecretKey(environment),
    payload: {
      sub: environment.id,
      pub: true,
      scopes: [
        `read:runs:${runFriendlyId}`,
        `write:inputStreams:${runFriendlyId}`,
      ],
    },
    expirationTime: "1h",
  });
}
