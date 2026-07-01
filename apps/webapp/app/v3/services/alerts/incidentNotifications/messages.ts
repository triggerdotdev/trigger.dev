import { type KnownBlock } from "@slack/web-api";
import { type NormalizedIncidentUpdate } from "~/services/betterstack/incidentWebhook";

// Pure, IO-free formatting helpers shared by every delivery surface.

const STATUS_PAGE_URL = "https://status.trigger.dev";

type StatusPresentation = {
  label: string;
  /** Emoji used in Slack/Discord text. */
  emoji: string;
  /** Whether this update represents a recovery. */
  resolved: boolean;
};

export function presentStatus(statusIndicator: string): StatusPresentation {
  switch (statusIndicator.toLowerCase()) {
    case "operational":
      return { label: "Resolved", emoji: "✅", resolved: true };
    case "degraded":
      return { label: "Degraded performance", emoji: "⚠️", resolved: false };
    case "maintenance":
      return { label: "Maintenance", emoji: "🔧", resolved: false };
    case "downtime":
    default:
      return { label: "Outage", emoji: "🔴", resolved: false };
  }
}

export function buildSubject(update: NormalizedIncidentUpdate): string {
  const status = presentStatus(update.statusIndicator);
  return `[Trigger.dev ${status.label}] ${update.name}`;
}

/** Link to the incident on the status page, falling back to the page root. */
export function incidentUrl(update: NormalizedIncidentUpdate): string {
  return update.shortlink ?? STATUS_PAGE_URL;
}

export function buildPlainTextBody(update: NormalizedIncidentUpdate): string {
  const status = presentStatus(update.statusIndicator);
  const lines = [`${status.emoji} ${update.name} — ${status.label}`];

  if (update.body) {
    lines.push("", update.body);
  }

  lines.push("", `Status page: ${incidentUrl(update)}`);
  return lines.join("\n");
}

export function buildSlackBlocks(update: NormalizedIncidentUpdate): KnownBlock[] {
  const status = presentStatus(update.statusIndicator);

  const blocks: KnownBlock[] = [
    {
      type: "header",
      text: { type: "plain_text", text: `${status.emoji} ${update.name}`, emoji: true },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Status:* ${status.label}` },
    },
  ];

  if (update.body) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: update.body },
    });
  }

  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: `<${incidentUrl(update)}|View status page>` }],
  });

  return blocks;
}

export function buildDiscordPayload(update: NormalizedIncidentUpdate) {
  const status = presentStatus(update.statusIndicator);
  // Lowercase to match presentStatus so "Degraded" gets amber, not outage red.
  const normalizedStatus = update.statusIndicator.toLowerCase();

  // Green when resolved, amber when degraded, else red.
  const color = status.resolved ? 0x2ecc71 : normalizedStatus === "degraded" ? 0xf1c40f : 0xe74c3c;

  return {
    embeds: [
      {
        title: `${status.emoji} ${update.name}`,
        description: update.body || status.label,
        url: incidentUrl(update),
        color,
        footer: { text: `Status: ${status.label}` },
      },
    ],
  };
}
