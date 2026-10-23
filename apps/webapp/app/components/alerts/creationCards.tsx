import { EyeIcon } from "@heroicons/react/20/solid";
import type { ReactNode } from "react";
import { ChatActionsRow, ChatSystemBlock } from "~/components/dashboard-agent/chat-layout";
import type { AlertCreatedBlock } from "@internal/dashboard-agent-contracts";
import { WatchResultBlock } from "~/components/dashboard-agent/WatchResultBlock";
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
  onCreate: () => void;
  onCustomize: () => void;
  onStartOver: () => void;
  submitting?: boolean;
  blockedReason?: string;
  createDisabled?: boolean;
  onPreview?: () => void;
  previewDisabled?: boolean;
};

export function WatchStyleReviewCard({
  fields,
  actions,
  detail,
}: {
  fields: ReviewCardFields;
  actions: ReviewCardActions;
  detail?: ReactNode;
}) {
  const scopeVal = fields.scopeValue ? ` · ${fields.scopeValue}` : "";

  return (
    <ChatSystemBlock
      label="Watch"
      icon={<EyeIcon className="size-3.5 shrink-0 text-text-dimmed" />}
      actions={
        <ChatActionsRow>
          <Button
            variant="primary/small"
            disabled={
              actions.submitting || actions.createDisabled || Boolean(actions.blockedReason)
            }
            onClick={actions.onCreate}
          >
            {actions.submitting ? "Creating…" : "Create alert"}
          </Button>
          {actions.onPreview ? (
            <Button
              variant="secondary/small"
              disabled={actions.previewDisabled}
              onClick={actions.onPreview}
            >
              Preview
            </Button>
          ) : null}
          <Button variant="minimal/small" onClick={actions.onCustomize}>
            Customize
          </Button>
          <Button variant="minimal/small" onClick={actions.onStartOver}>
            Start over
          </Button>
        </ChatActionsRow>
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
      {actions.blockedReason ? (
        <p role="alert" className="text-xxs text-error">
          {actions.blockedReason}
        </p>
      ) : null}
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
      <WatchResultBlock
        block={{
          type: "watch_result",
          outcome: "watching",
          headline: `${block.name} is active.`,
          lifetime: null,
          detail: null,
          followUp: block.rows.map((row) =>
            row.expiresAt ? `It expires ${new Date(row.expiresAt).toLocaleString()}.` : row.value
          ),
          watchId: null,
        }}
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
      <WatchResultBlock
        block={{
          type: "watch_result",
          outcome: "watching",
          headline: `${fields.name} is updated.`,
          lifetime: "Recurring.",
          detail: [fields.conditionSummary, fields.scopeSummary].filter(Boolean).join(" · "),
          followUp: [`Notifying: ${fields.notifyLabel}.`],
          watchId: null,
        }}
        actions={
          <LinkButton to={alertDetailPath} variant="secondary/small">
            View alert
          </LinkButton>
        }
      />
    </div>
  );
}
