export const ALERT_ACTION_PATH = "/resources/alerts/action";

export type AlertChatAction = "resolve" | "stop";

export type AlertActionProposal = {
  ok: true;
  pending: true;
  alertId: string;
  name: string;
  projectId: string;
  environmentId: string;
  action: AlertChatAction;
};

const MESSAGE_ID_PREFIX = "alert_action:";

export function parseAlertActionProposal(output: unknown): AlertActionProposal | null {
  const o = output as Partial<AlertActionProposal> | null | undefined;
  if (
    !o ||
    o.pending !== true ||
    typeof o.alertId !== "string" ||
    typeof o.name !== "string" ||
    typeof o.projectId !== "string" ||
    typeof o.environmentId !== "string"
  ) {
    return null;
  }
  return o.action === "resolve" || o.action === "stop" ? (o as AlertActionProposal) : null;
}

export function alertActionDoneText(action: AlertChatAction, name: string): string {
  return action === "resolve"
    ? `${name} is resolved. It re-arms and keeps monitoring.`
    : `${name} is stopped.`;
}

function literalMarkdown(text: string): string {
  const flat = text.replace(/\s+/g, " ");
  const longestRun = Math.max(0, ...(flat.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longestRun + 1);
  return `${fence} ${flat} ${fence}`;
}

export type AlertActionMessage = {
  id: string;
  role: "assistant";
  parts: [{ type: "text"; text: string }];
};

export function alertActionMessage(
  toolCallId: string,
  action: AlertChatAction,
  name: string
): AlertActionMessage {
  return {
    id: `${MESSAGE_ID_PREFIX}${toolCallId}`,
    role: "assistant",
    parts: [{ type: "text", text: alertActionDoneText(action, literalMarkdown(name)) }],
  };
}

export function confirmedAlertActions(messages: { id: string }[]): Set<string> {
  return new Set(
    messages
      .filter((m) => m.id.startsWith(MESSAGE_ID_PREFIX))
      .map((m) => m.id.slice(MESSAGE_ID_PREFIX.length))
  );
}
