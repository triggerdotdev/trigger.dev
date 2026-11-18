import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import {
  ALERT_ACTION_PATH,
  alertActionDoneText,
  confirmedAlertActions,
  parseAlertActionProposal,
} from "~/components/alerts/alertActionCard";
import { AlertActionCard } from "~/components/alerts/creationCards";
import { useOptionalOrganization } from "~/hooks/useOrganizations";
import { useMonitoringPlanHost } from "./MonitoringPlanBlock";

const ConfirmedContext = createContext<ReadonlySet<string>>(new Set());

export function AlertActionsProvider({
  messages,
  children,
}: {
  messages: { id: string }[];
  children: ReactNode;
}) {
  const key = [...confirmedAlertActions(messages)].join("\n");
  const confirmed = useMemo(() => new Set(key ? key.split("\n") : []), [key]);
  return <ConfirmedContext.Provider value={confirmed}>{children}</ConfirmedContext.Provider>;
}

export function AlertActionBlock({ toolCallId, output }: { toolCallId: string; output: unknown }) {
  const proposal = parseAlertActionProposal(output);
  const confirmed = useContext(ConfirmedContext).has(toolCallId);
  const host = useMonitoringPlanHost();
  const organization = useOptionalOrganization();
  const [done, setDone] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  if (!proposal || (confirmed && !done)) return null;

  const confirm = async () => {
    if (!organization) return;
    setSubmitting(true);
    setError(undefined);
    try {
      const resp = await fetch(ALERT_ACTION_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organizationId: organization.id,
          projectId: proposal.projectId,
          environmentId: proposal.environmentId,
          alertId: proposal.alertId,
          intent: proposal.action,
          toolCallId,
          ...(host?.chatId ? { transcriptChatId: host.chatId } : {}),
        }),
      });
      const data = (await resp.json().catch(() => ({}))) as { error?: string };
      if (!resp.ok) return setError(data.error ?? "Something went wrong. Try again.");
      setDone(alertActionDoneText(proposal.action, proposal.name));
    } catch {
      setError("Something went wrong. Try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AlertActionCard
      name={proposal.name}
      action={proposal.action}
      done={done}
      submitting={submitting || !organization}
      error={error}
      onConfirm={confirm}
      onCancel={() => setDone("Cancelled. Nothing changed.")}
    />
  );
}
