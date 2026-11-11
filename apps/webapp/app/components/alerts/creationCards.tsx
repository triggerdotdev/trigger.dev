import { EyeIcon } from "@heroicons/react/20/solid";
import type { ReactNode } from "react";
import { ChatActionsRow, ChatSystemBlock } from "~/components/dashboard-agent/chat-layout";
import type { AlertCreatedBlock } from "@internal/dashboard-agent-contracts";
import { Button, LinkButton } from "~/components/primitives/Buttons";

export type ReviewCardFields = {
  name: string;
  conditionSummary: string;
  scopeLabel: string;
  scopeValue?: string;
  environmentTitle?: string;
  behavior: "recurring";
  notifyLabel: string;
};

export type ReviewCardActions = {
  onCreate?: () => void;
  onCustomize: () => void;
  onStartOver?: () => void;
  submitting?: boolean;
  blockedReason?: string;
  createDisabled?: boolean;
  onPreview?: () => void;
  previewDisabled?: boolean;
  startOverLabel?: string;
};

export function WatchStyleReviewCard({
  fields,
  actions,
  detail,
  status,
}: {
  fields: ReviewCardFields;
  actions?: ReviewCardActions;
  detail?: ReactNode;
  status?: ReactNode;
}) {
  const scopeVal = fields.scopeValue ? ` · ${fields.scopeValue}` : "";

  return (
    <ChatSystemBlock
      label="Watch"
      icon={<EyeIcon className="size-3.5 shrink-0 text-text-dimmed" />}
      actions={
        status ??
        (actions && (
          <ChatActionsRow>
            {actions.onCreate ? (
              <Button
                variant="primary/small"
                disabled={
                  actions.submitting || actions.createDisabled || Boolean(actions.blockedReason)
                }
                onClick={actions.onCreate}
              >
                {actions.submitting ? "Creating…" : "Create alert"}
              </Button>
            ) : null}
            {actions.onPreview ? (
              <Button
                variant="secondary/small"
                disabled={actions.previewDisabled}
                onClick={actions.onPreview}
              >
                Preview
              </Button>
            ) : null}
            <Button
              variant="minimal/small"
              disabled={actions.submitting}
              onClick={actions.onCustomize}
            >
              Customize
            </Button>
            {actions.onStartOver ? (
              <Button
                variant="minimal/small"
                disabled={actions.submitting}
                onClick={actions.onStartOver}
              >
                {actions.startOverLabel ?? "Start over"}
              </Button>
            ) : null}
          </ChatActionsRow>
        ))
      }
    >
      <p className="truncate text-sm font-medium text-text-bright">{fields.name}</p>
      {detail}
      <p className="text-xs tabular-nums text-text-dimmed">{fields.conditionSummary}</p>
      <p className="text-xs text-text-dimmed">
        {fields.environmentTitle ? `${fields.environmentTitle} · ` : null}
        {fields.scopeLabel}
        {scopeVal} · Recurring
      </p>
      <p className="text-xs text-text-dimmed">Notify: {fields.notifyLabel}</p>
      {actions?.blockedReason && !status ? (
        <p role="alert" className="text-xxs text-error">
          {actions.blockedReason}
        </p>
      ) : null}
    </ChatSystemBlock>
  );
}

function AlertStatusBlock({
  headline,
  lifetime,
  detail,
  lines,
  actions,
}: {
  headline: string;
  lifetime?: string;
  detail?: string;
  lines: string[];
  actions?: ReactNode;
}) {
  return (
    <ChatSystemBlock
      label="Watch"
      icon={<EyeIcon className="size-3.5 shrink-0 text-text-dimmed" />}
      actions={actions}
    >
      <p className="text-sm text-text-bright">{headline}</p>
      {lifetime ? <p className="text-xs text-text-dimmed">{lifetime}</p> : null}
      {detail ? <p className="text-xs text-text-dimmed">{detail}</p> : null}
      {lines.map((line) => (
        <p key={line} className="text-xs text-text-dimmed">
          {line}
        </p>
      ))}
    </ChatSystemBlock>
  );
}

export function AlertCreatedCard({
  block,
  alertDetailPath,
}: {
  block: AlertCreatedBlock;
  alertDetailPath?: string;
}) {
  return (
    <div data-testid="alert-created" className="min-w-0">
      <AlertStatusBlock
        headline={`${block.name} is active.`}
        lines={block.rows.map((row) =>
          row.expiresAt ? `It expires ${new Date(row.expiresAt).toLocaleString()}.` : row.value
        )}
        actions={
          alertDetailPath ? (
            <LinkButton to={alertDetailPath} variant="secondary/small">
              View alert
            </LinkButton>
          ) : undefined
        }
      />
    </div>
  );
}

export type UpdatedCardFields = {
  name: string;
  conditionSummary: string;
  scopeSummary?: string;
  behavior: "recurring";
  notifyLabel: string;
};

export function AlertUpdatedCard({
  fields,
  alertDetailPath,
}: {
  fields: UpdatedCardFields;
  alertDetailPath: string;
}) {
  return (
    <div data-testid="alert-updated" className="min-w-0">
      <AlertStatusBlock
        headline={`${fields.name} is updated.`}
        lifetime="Recurring."
        detail={[fields.conditionSummary, fields.scopeSummary].filter(Boolean).join(" · ")}
        lines={[`Notifying: ${fields.notifyLabel}.`]}
        actions={
          <LinkButton to={alertDetailPath} variant="secondary/small">
            View alert
          </LinkButton>
        }
      />
    </div>
  );
}
