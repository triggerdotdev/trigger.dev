import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { prisma } from "~/db.server";
import { logger } from "~/services/logger.server";

/**
 * POST /webhooks/slack
 * Receives Slack messages and routes them to the correct OpenClaw agent
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const event = (await request.json()) as any;

    // Handle Slack URL verification
    if (event.type === "url_verification") {
      return json({ challenge: event.challenge });
    }

    // Handle message events
    if (event.type === "event_callback" && event.event.type === "message") {
      const slackEvent = event.event;
      const workspaceId = event.team_id;
      const channel = slackEvent.channel;
      const text = slackEvent.text;
      const userId = slackEvent.user;

      logger.info("Received Slack message", {
        workspaceId,
        channel,
        userId,
        text: text?.substring(0, 100),
      });

      // Find the agent for this workspace
      const agent = await prisma.agentConfig.findFirst({
        where: {
          slackWorkspaceId: workspaceId,
          messagingPlatform: "slack",
          status: "healthy",
        },
      });

      if (!agent) {
        logger.warn("No agent found for workspace", { workspaceId });
        return json({ ok: true }); // Don't error, just ignore
      }

      if (!agent.containerPort) {
        logger.warn("Agent has no container port", { agentId: agent.id });
        return json({ ok: true });
      }

      // Route message to OpenClaw container (on VPS)
      const containerUrl = `http://178.128.150.129:${agent.containerPort}`;

      try {
        const containerResponse = await fetch(`${containerUrl}/api/message`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text,
            userId,
            channel,
            metadata: {
              slackUserId: userId,
              slackChannel: channel,
              timestamp: new Date().toISOString(),
            },
          }),
        });

        const containerData = await containerResponse.json();
        const agentResponse = containerData?.response || "I couldn't process that";

        // Log execution
        await prisma.agentExecution.create({
          data: {
            agentId: agent.id,
            message: text,
            response: agentResponse,
            executionTimeMs: 0, // TODO: Measure actual execution time
            inputTokens: containerData?.inputTokens,
            outputTokens: containerData?.outputTokens,
          },
        });

        // Send response back to Slack
        if (agent.slackWebhookToken) {
          await fetch(`https://hooks.slack.com/services/${agent.slackWebhookToken}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              channel,
              text: agentResponse,
              reply_broadcast: false,
              thread_ts: slackEvent.thread_ts || slackEvent.ts,
            }),
          });
        }

        logger.info("Message processed successfully", {
          agentId: agent.id,
          responseLength: agentResponse.length,
        });
      } catch (containerError) {
        logger.error("Failed to route message to container", {
          agentId: agent.id,
          containerPort: agent.containerPort,
          error: containerError,
        });

        // Mark agent as unhealthy
        await prisma.agentConfig.update({
          where: { id: agent.id },
          data: { status: "unhealthy" },
        });

        // Log health check failure
        await prisma.agentHealthCheck.create({
          data: {
            agentId: agent.id,
            isHealthy: false,
            errorMessage: containerError instanceof Error ? containerError.message : "Unknown error",
          },
        });

        return json({ ok: true }); // Don't fail the webhook, just mark agent unhealthy
      }
    }

    return json({ ok: true });
  } catch (error) {
    logger.error("Webhook processing error", { error });
    return json({ ok: true }, { status: 200 }); // Always return 200 to Slack
  }
};
