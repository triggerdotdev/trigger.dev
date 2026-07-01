import { env } from "~/env.server";
import { type NormalizedIncidentUpdate } from "~/services/betterstack/incidentWebhook";
import { logger } from "~/services/logger.server";
import { buildDiscordPayload } from "./messages";

/** Post to the Discord webhook. No-op if unconfigured; throws on non-2xx to retry. */
export async function deliverIncidentToDiscord(update: NormalizedIncidentUpdate): Promise<void> {
  const webhookUrl = env.INCIDENT_NOTIFY_DISCORD_WEBHOOK_URL;
  if (!webhookUrl) {
    logger.debug("Incident Discord delivery skipped: no webhook URL configured");
    return;
  }

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildDiscordPayload(update)),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Discord webhook returned ${response.status}: ${detail.slice(0, 200)}`);
  }

  logger.info("Incident Discord delivery complete", { updateId: update.updateId });
}
