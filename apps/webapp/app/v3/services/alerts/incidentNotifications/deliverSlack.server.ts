import { WebClient } from "@slack/web-api";
import { env } from "~/env.server";
import { type NormalizedIncidentUpdate } from "~/services/betterstack/incidentWebhook";
import { logger } from "~/services/logger.server";
import { singleton } from "~/utils/singleton";
import { buildSlackBlocks, buildSubject } from "./messages";

const slack = singleton("incident-slack-client", () => new WebClient(env.SLACK_BOT_TOKEN));

type Channel = { id?: string; name?: string; is_archived?: boolean };

/**
 * Post to every Slack channel whose name starts with the configured prefix.
 * Best-effort per channel. No-op if the bot token or prefix isn't configured.
 */
export async function deliverIncidentToSlack(update: NormalizedIncidentUpdate): Promise<void> {
  if (!env.SLACK_BOT_TOKEN) {
    logger.debug("Incident Slack delivery skipped: no bot token configured");
    return;
  }

  // Blank prefix would match every channel (startsWith("")), so treat as unset.
  const prefix = env.INCIDENT_NOTIFY_SLACK_CHANNEL_PREFIX?.trim();
  if (!prefix) {
    logger.debug("Incident Slack delivery skipped: no channel prefix configured");
    return;
  }

  const channels = await listChannelsWithPrefix(prefix);

  if (channels.length === 0) {
    logger.warn("Incident Slack delivery: no matching channels", { prefix });
    return;
  }

  const subject = buildSubject(update);
  const blocks = buildSlackBlocks(update);

  let delivered = 0;
  for (const channel of channels) {
    if (!channel.id) {
      continue;
    }

    try {
      await slack.chat.postMessage({
        channel: channel.id,
        text: subject,
        blocks,
        unfurl_links: false,
      });
      delivered += 1;
    } catch (error) {
      // The bot may not be a member of every matching channel — log and move on.
      logger.warn("Incident Slack delivery failed for channel", {
        channel: channel.name,
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  logger.info("Incident Slack delivery complete", {
    matched: channels.length,
    delivered,
    updateId: update.updateId,
  });
}

async function listChannelsWithPrefix(prefix: string): Promise<Channel[]> {
  const matched: Channel[] = [];
  let cursor: string | undefined = undefined;

  do {
    const response = await slack.conversations.list({
      types: "public_channel,private_channel",
      exclude_archived: true,
      cursor,
      limit: 999,
    });

    for (const channel of response.channels ?? []) {
      if (!channel.is_archived && channel.name?.startsWith(prefix)) {
        matched.push(channel);
      }
    }

    cursor = response.response_metadata?.next_cursor || undefined;
  } while (cursor);

  return matched;
}
