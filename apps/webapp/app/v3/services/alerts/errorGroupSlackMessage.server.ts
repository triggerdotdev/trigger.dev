type ErrorAlertClassification = "new_issue" | "regression" | "unignored";

export type ErrorAlertPayload = {
  channelId: string;
  projectId: string;
  classification: ErrorAlertClassification;
  error: {
    fingerprint: string;
    environmentId: string;
    environmentSlug: string;
    environmentName: string;
    taskIdentifier: string;
    errorType: string;
    errorMessage: string;
    sampleStackTrace: string;
    firstSeen: string;
    lastSeen: string;
    occurrenceCount: number;
  };
};

const SLACK_SECTION_TEXT_MAX_LENGTH = 3000;
const SLACK_FIELD_TEXT_MAX_LENGTH = 2000;
const SLACK_FALLBACK_TEXT_MAX_LENGTH = 4000;

function truncateSlackText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

function escapeSlackMrkdwn(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function classificationLabel(classification: ErrorAlertClassification): string {
  switch (classification) {
    case "new_issue":
      return "New error";
    case "regression":
      return "Regression";
    case "unignored":
      return "Error resurfaced";
  }
}

function formatSlackTimestamp(date: Date): string {
  const unix = Math.floor(date.getTime() / 1000);
  const fallback =
    new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
      timeZone: "UTC",
    }).format(date) + " UTC";
  return `<!date^${unix}^{date_short_pretty} {time_secs}|${fallback}>`;
}

export function buildErrorGroupSlackMessage(
  payload: ErrorAlertPayload,
  errorLink: string,
  projectName: string
): { text: string; mrkdwn: false; parse: "none"; blocks: object[]; attachments: object[] } {
  const label = classificationLabel(payload.classification);
  const errorType = payload.error.errorType || "Error";
  const task = payload.error.taskIdentifier;
  const envName = payload.error.environmentName;
  const fallbackText = escapeSlackMrkdwn(`${label}: ${errorType} in ${task} [${envName}]`);

  return {
    text: truncateSlackText(fallbackText, SLACK_FALLBACK_TEXT_MAX_LENGTH),
    // Top-level `text` is parsed as mrkdwn with URL auto-linking by default; disable both so
    // untrusted error/task/env values render literally in notification and screen-reader previews.
    mrkdwn: false,
    parse: "none",
    blocks: [
      {
        type: "section",
        text: {
          type: "plain_text",
          text: truncateSlackText(
            `${label} in ${task} [${envName}]`,
            SLACK_SECTION_TEXT_MAX_LENGTH
          ),
        },
      },
    ],
    attachments: [
      {
        color: "danger",
        blocks: [
          {
            type: "section",
            text: {
              type: "plain_text",
              text: truncateSlackText(
                payload.error.sampleStackTrace || payload.error.errorMessage || errorType,
                SLACK_SECTION_TEXT_MAX_LENGTH
              ),
            },
          },
          {
            type: "section",
            fields: [
              {
                type: "plain_text",
                text: truncateSlackText(`Task:\n${task}`, SLACK_FIELD_TEXT_MAX_LENGTH),
              },
              {
                type: "plain_text",
                text: truncateSlackText(`Environment:\n${envName}`, SLACK_FIELD_TEXT_MAX_LENGTH),
              },
              {
                type: "plain_text",
                text: truncateSlackText(`Project:\n${projectName}`, SLACK_FIELD_TEXT_MAX_LENGTH),
              },
              {
                type: "plain_text",
                text: `Occurrences:\n${payload.error.occurrenceCount}`,
              },
              {
                type: "mrkdwn",
                text: `*Last seen:*\n${formatSlackTimestamp(new Date(Number(payload.error.lastSeen)))}`,
              },
            ],
          },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: { type: "plain_text", text: "Investigate" },
                url: errorLink,
                style: "primary",
              },
            ],
          },
        ],
      },
    ],
  };
}
