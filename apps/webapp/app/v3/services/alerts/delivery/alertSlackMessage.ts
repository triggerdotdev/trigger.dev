import {
  ALERT_RAISED_BUTTON_TEXT,
  ALERT_RAISED_LABEL,
  alertRaisedSentence,
} from "emails/src/alertRaisedContent";

function escapeSlackText(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function buildAlertSlackMessage(params: {
  alertName: string;
  headline: string;
  project: string;
  environment: string;
  raisedAt: string;
  detail?: string | null;
  dashboardLink: string;
}) {
  const blocks = [
    { type: "header", text: { type: "plain_text", text: ALERT_RAISED_LABEL } },
    { type: "section", text: { type: "mrkdwn", text: `*${escapeSlackText(params.headline)}*` } },
    {
      type: "section",
      text: { type: "mrkdwn", text: escapeSlackText(alertRaisedSentence(params)) },
    },
    ...(params.detail
      ? [{ type: "section", text: { type: "mrkdwn", text: escapeSlackText(params.detail) } }]
      : []),
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: ALERT_RAISED_BUTTON_TEXT },
          url: params.dashboardLink,
        },
      ],
    },
  ];

  return { text: `${ALERT_RAISED_LABEL}: ${escapeSlackText(params.alertName)}`, blocks };
}
