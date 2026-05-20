import { json } from "@remix-run/server-runtime";
import { type ActionFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import type { Prisma } from "@trigger.dev/database";
import { SessionId } from "@trigger.dev/core/v3/isomorphic";
import { prisma } from "~/db.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";
import { mintSessionToken } from "~/services/realtime/mintSessionToken.server";
import { ensureRunForSession } from "~/services/realtime/sessionRunManager.server";

const PlaygroundAction = z.object({
  intent: z.enum(["create", "start", "save", "delete"]),
  agentSlug: z.string(),
  // For create
  conversationId: z.string().optional(),
  // For start (replaces "trigger" — atomically creates the Session and
  // triggers its first run, returns a session-scoped PAT)
  chatId: z.string().optional(),
  payload: z.string().optional(),
  clientData: z.string().optional(),
  tags: z.string().optional(),
  machine: z.string().optional(),
  maxAttempts: z.string().optional(),
  maxDuration: z.string().optional(),
  version: z.string().optional(),
  region: z.string().optional(),
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

    case "start": {
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

      if (!chatId) {
        return json({ error: "chatId is required" }, { status: 400 });
      }

      // Parse the optional initial payload — used as the basePayload
      // for the first run trigger. After session create, the agent
      // reads subsequent messages from `.in/append` so the payload
      // here is just the bootstrap.
      let payload: Record<string, any> = {};
      try {
        payload = payloadStr ? (JSON.parse(payloadStr) as Record<string, any>) : {};
      } catch {
        return json({ error: "Invalid payload JSON" }, { status: 400 });
      }

      let parsedClientData: unknown;
      try {
        parsedClientData = clientData ? JSON.parse(clientData) : undefined;
      } catch {
        /* invalid JSON — fall through with undefined */
      }

      const tags = [
        `chat:${chatId}`,
        "playground:true",
        ...(tagsStr ? tagsStr.split(",").map((t) => t.trim()).filter(Boolean) : []),
      ].slice(0, 5);

      const triggerConfig = {
        basePayload: {
          // The first run boots before the user's first message lands on
          // `.in/append`, so it sees `messages: []` and `trigger: "preload"`.
          // Mirrors the defaults in `chat.createStartSessionAction` —
          // chat.agent's runtime reads `payload.messages.length` so the
          // field must be an array, not undefined.
          messages: [],
          trigger: "preload",
          ...payload,
          chatId,
          ...(parsedClientData ? { metadata: parsedClientData } : {}),
        },
        ...(machine ? { machine } : {}),
        tags,
        ...(maxAttempts ? { maxAttempts: parseInt(maxAttempts, 10) } : {}),
        ...(maxDuration ? { maxDuration: parseInt(maxDuration, 10) } : {}),
        ...(version ? { lockToVersion: version } : {}),
        ...(region ? { region } : {}),
      };

      // Atomic: upsert the Session, then trigger the first run via
      // the optimistic-claim path. The transport's `accessToken`
      // callback hits this endpoint on initial start AND on 401 — the
      // upsert + ensureRunForSession combo is idempotent so repeat
      // calls converge to the same session and (if alive) reuse the
      // existing run.
      const { id: sessionId, friendlyId } = SessionId.generate();
      const session = await prisma.session.upsert({
        where: {
          runtimeEnvironmentId_externalId: {
            runtimeEnvironmentId: environment.id,
            externalId: chatId,
          },
        },
        create: {
          id: sessionId,
          friendlyId,
          externalId: chatId,
          type: "chat.agent",
          taskIdentifier: agentSlug,
          triggerConfig: triggerConfig as unknown as Prisma.InputJsonValue,
          tags: ["playground"],
          projectId: project.id,
          runtimeEnvironmentId: environment.id,
          environmentType: environment.type,
          organizationId: project.organizationId,
          // Stamp the org's S2 basin so realtime reads on this
          // session's `.in/.out` channels resolve without joining
          // Organization. Null until per-org basins are provisioned.
          streamBasinName: environment.organization.streamBasinName,
        },
        update: {
          // Refresh trigger config in case agent version / params changed
          triggerConfig: triggerConfig as unknown as Prisma.InputJsonValue,
        },
      });

      const ensureResult = await ensureRunForSession({
        session,
        environment,
        reason: "initial",
      });

      const run = await prisma.taskRun.findFirst({
        where: { id: ensureResult.runId },
        select: { friendlyId: true },
      });
      if (!run) {
        return json({ error: "Triggered run not found" }, { status: 500 });
      }

      // Title: prefer the user message text on first start, else a
      // generic placeholder. The conversation row is the playground's
      // own surface — separate from the Session row that drives the
      // trigger.
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
          runId: ensureResult.runId,
          clientData: parsedClientData as any,
          projectId: project.id,
          runtimeEnvironmentId: environment.id,
          userId,
        },
        update: {
          runId: ensureResult.runId,
          clientData: parsedClientData as any,
          title,
        },
      });

      const publicAccessToken = await mintSessionToken(environment, chatId);

      return json({
        runId: run.friendlyId,
        publicAccessToken,
        conversationId: conversation.id,
      });
    }

    case "save": {
      const { chatId, messages: messagesStr, lastEventId } = parsed.data;
      if (!chatId) {
        return json({ error: "chatId is required" }, { status: 400 });
      }

      let messagesData: unknown;
      try {
        messagesData = messagesStr ? JSON.parse(messagesStr) : undefined;
      } catch {
        return json({ error: "Invalid messages JSON" }, { status: 400 });
      }

      // Extract title from the first user message if the conversation still has the default title.
      // This handles the case where a preloaded conversation gets its first real message
      // via the input stream (bypassing the trigger action that normally sets the title).
      let titleUpdate: { title: string } | undefined;
      if (messagesData && Array.isArray(messagesData)) {
        const existing = await prisma.playgroundConversation.findFirst({
          where: { chatId, runtimeEnvironmentId: environment.id, userId },
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
          userId,
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
