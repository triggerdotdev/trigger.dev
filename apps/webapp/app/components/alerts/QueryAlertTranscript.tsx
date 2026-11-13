import { type ReactNode, useEffect, useState } from "react";
import { AlertChannelsDialog } from "~/components/alerts/AlertChannelsDialog";
import { alertCreatedBlock, REVIEW_MESSAGE } from "~/components/alerts/alertCreatedCard";
import {
  AlertCreatedCard,
  WatchStyleReviewCard,
  type ReviewCardFields,
} from "~/components/alerts/creationCards";
import { NewChatButton } from "~/components/alerts/creationControls";
import {
  QUERY_CONDITION_LABELS,
  QUERY_SCOPE_LABEL,
  queryConditionModes,
  querySignalOptions,
  UNUSABLE_QUERY,
  watchBlockedReasons,
  type QueryAlertMode,
  type QueryAlertPrefill,
} from "~/components/alerts/queryAlertLink";
import { QueryBlock } from "~/components/alerts/QueryBlock";
import { QueryPreviewResult } from "~/components/alerts/QueryPreviewResult";
import { useQueryAlertDraft, type QueryAlertChat } from "~/components/alerts/useQueryAlertDraft";
import { CONTINUE_OPTION, NO_NOTIFIER } from "~/components/alerts/wizardSteps";
import { notifyLabel } from "~/components/dashboard-agent/alert-creation/CreationFlow";
import {
  CUSTOM_EXPIRY,
  expiryLabel,
  isExpiryTimestamp,
  type DraftPrefillParams,
} from "~/components/dashboard-agent/alert-creation/flow-state";
import { ChatText, ChatTranscript, ChatTurn } from "~/components/dashboard-agent/chat-layout";
import { ChatWizardCard, type ChatWizardStep } from "~/components/dashboard-agent/ChatWizardCard";
import { Button } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { Spinner } from "~/components/primitives/Spinner";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { v3EnvironmentPath } from "~/utils/pathBuilder";

export type QueryWatchPrefill = {
  query: string;
  name?: string;
  period?: string;
  mode?: QueryAlertMode;
  measure?: string;
  operator?: ">" | "<";
  value?: number;
  windowSec?: number;
  windowMinutes?: number;
  expiry?: string;
  notifiers?: string[];
};

export function queryWatchPrefill(
  prefill: DraftPrefillParams | undefined
): QueryWatchPrefill | undefined {
  if (prefill?.source !== "query" || !prefill.query) return undefined;
  const { query, period, mode, measure } = prefill;
  return { query, period, mode, measure };
}

type Analyzed = Pick<QueryAlertPrefill, "analysis" | "names">;

const DEFAULT_PERIOD = "7d";
const NEEDS_THRESHOLD = "Enter a threshold first";
const OPERATORS = [
  { id: ">", label: "Above" },
  { id: "<", label: "Below" },
];

type QueryAlertCreated = { alertId?: string; chatId?: string; name: string };

export function useQueryAnalysis(prefill: QueryWatchPrefill) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const analyzePath = `/resources${v3EnvironmentPath(organization, project, environment)}/alerts/analyze-query`;
  const [analyzed, setAnalyzed] = useState<Analyzed | "error">();

  useEffect(() => {
    let current = true;
    fetch(analyzePath, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: prefill.query }),
    })
      .then(async (resp) => (resp.ok ? ((await resp.json()) as Analyzed) : "error"))
      .catch(() => "error" as const)
      .then((result) => {
        if (current) setAnalyzed(result);
      });
    return () => {
      current = false;
    };
  }, [analyzePath, prefill.query]);

  const full: QueryAlertPrefill | undefined =
    analyzed && analyzed !== "error"
      ? { ...prefill, period: prefill.period ?? DEFAULT_PERIOD, ...analyzed }
      : undefined;
  const blocked = full ? watchBlockedReasons(full.analysis, full.query) : [];
  const reasons =
    blocked.length || !full || querySignalOptions(full.analysis).length
      ? blocked
      : [UNUSABLE_QUERY];
  return { analyzed, full, reasons };
}

export function QueryAlertTranscript({
  prefill,
  alertDetailPath,
  onNewChat,
  onCreated,
  environmentTitle,
  chat,
}: {
  prefill: QueryWatchPrefill;
  alertDetailPath: (alertId: string) => string;
  onNewChat?: () => void;
  onCreated?: (info: QueryAlertCreated) => void;
  environmentTitle?: string;
  chat?: QueryAlertChat;
}) {
  const { analyzed, full, reasons } = useQueryAnalysis(prefill);

  const header = (
    <ChatTurn speaker="user">
      <ChatText speaker="user" text="Watch this query" />
    </ChatTurn>
  );

  if (!analyzed) {
    return (
      <ChatTranscript>
        <div data-testid="query-alert-flow" className="flex flex-col gap-3">
          {header}
          <ChatTurn speaker="assistant">
            <Spinner className="size-4" />
          </ChatTurn>
        </div>
      </ChatTranscript>
    );
  }

  if (!full || reasons.length) {
    return (
      <ChatTranscript>
        <div data-testid="query-alert-flow" className="flex flex-col gap-3">
          {header}
          <ChatTurn speaker="assistant">
            <div data-testid="query-alert-unavailable" className="flex flex-col gap-2">
              <QueryBlock query={prefill.query} />
              <Callout variant="warning">
                {(full ? reasons : [UNUSABLE_QUERY]).map((reason) => (
                  <p key={reason}>{reason}</p>
                ))}
              </Callout>
            </div>
          </ChatTurn>
        </div>
      </ChatTranscript>
    );
  }

  return (
    <QueryAlertChat
      prefill={full}
      header={header}
      alertDetailPath={alertDetailPath}
      onNewChat={onNewChat}
      onCreated={onCreated}
      environmentTitle={environmentTitle}
      chat={chat}
    />
  );
}

function queryReviewFields(
  draft: ReturnType<typeof useQueryAlertDraft>,
  environmentTitle?: string
): ReviewCardFields {
  const conditionSummary =
    draft.mode === "threshold"
      ? `${draft.measure} ${draft.operator} ${draft.valueText} for ${draft.windowMinutes}m`
      : draft.mode === "absence"
        ? `No matching results for ${draft.windowMinutes}m`
        : QUERY_CONDITION_LABELS.match;
  return {
    name: draft.name,
    conditionSummary,
    scopeLabel: QUERY_SCOPE_LABEL,
    environmentTitle,
    behavior: "recurring",
    notifyLabel: notifyLabel(draft.flow.answers, draft.channels),
  };
}

function stepIds(signalCount: number, mode: QueryAlertMode): string[] {
  return [
    "query",
    ...(signalCount > 1 ? ["signal"] : []),
    "condition",
    ...(mode === "threshold" ? ["threshold"] : []),
    ...(mode === "match" ? [] : ["window"]),
    "expiry",
    "notifiers",
    "name",
  ];
}

export function useQueryAlertWizard(
  draft: ReturnType<typeof useQueryAlertDraft>,
  prefill: QueryAlertPrefill,
  {
    onDone,
    startAt = "query",
    initiallyAnswered = false,
  }: { onDone: () => void; startAt?: string; initiallyAnswered?: boolean }
) {
  const { analysis, signals, mode, flow, bounds } = draft;
  const [stepId, setStepId] = useState(startAt);
  const [answered, setAnswered] = useState<string[]>(() =>
    initiallyAnswered ? stepIds(signals.length, mode) : []
  );

  const ids = stepIds(signals.length, mode);
  const done = (id: string) => answered.includes(id);
  const advance = (from: string, nextMode: QueryAlertMode = mode) => {
    setAnswered((prev) => (prev.includes(from) ? prev : [...prev, from]));
    const order = stepIds(signals.length, nextMode);
    const next = order[order.indexOf(from) + 1];
    if (next) setStepId(next);
    else onDone();
  };
  const startOver = () => {
    setAnswered([]);
    setStepId("query");
  };

  const continueOption = (disabledReason?: string) => [
    { id: CONTINUE_OPTION, label: "Continue", disabledReason },
  ];
  const stepsById: Record<string, ChatWizardStep> = {
    query: {
      id: "query",
      question: "Watch this query?",
      allowSkip: false,
      content: <QueryBlock query={prefill.query} />,
      options: continueOption(),
      selected: done("query") ? [CONTINUE_OPTION] : [],
    },
    signal: {
      id: "signal",
      question: "Which value should it watch?",
      allowSkip: false,
      options: signals.map((s) => ({ id: s.id, label: s.label })),
      selected: done("signal") ? [draft.signal.id] : [],
    },
    condition: {
      id: "condition",
      question: "When should it fire?",
      allowSkip: false,
      options: draft.modes.map((m) => ({ id: m, label: QUERY_CONDITION_LABELS[m] })),
      selected: done("condition") ? [mode] : [],
    },
    threshold: {
      id: "threshold",
      question: `Fire when ${draft.signal.measure ?? "the value"} is`,
      allowSkip: false,
      fields: [
        {
          id: "value",
          ariaLabel: "Threshold",
          placeholder: "1000",
          numeric: true,
          live: true,
          current: draft.valueText || undefined,
          parse: (text) => (text.trim() && Number.isFinite(Number(text)) ? text.trim() : undefined),
          onSubmit: draft.setValueText,
          onClear: () => draft.setValueText(""),
        },
      ],
      options: OPERATORS.map((o) => ({
        ...o,
        disabledReason: draft.valueValid ? undefined : NEEDS_THRESHOLD,
      })),
      selected: (done("threshold") || prefill.operator) && draft.valueValid ? [draft.operator] : [],
    },
    window: {
      id: "window",
      question: "Over what window?",
      description: `At least ${bounds.min} min, at most ${bounds.max} min.`,
      allowSkip: false,
      fields: [
        {
          id: "window",
          ariaLabel: "Window",
          unit: "min",
          numeric: true,
          live: true,
          current: draft.windowText,
          rule: { min: bounds.min, max: bounds.max },
          parse: (text) => {
            const n = Number(text.trim());
            return Number.isInteger(n) && n >= bounds.min && n <= bounds.max
              ? String(n)
              : undefined;
          },
          onSubmit: draft.setWindowText,
        },
      ],
      options: continueOption(draft.windowValid ? undefined : "Enter a valid window"),
      selected: done("window") && draft.windowValid ? [CONTINUE_OPTION] : [],
    },
    expiry: draft.expiryStep,
    notifiers: {
      ...draft.notifiersStep,
      confirmLabel: "Continue",
      confirmDisabled: !draft.hasNotifier || flow.answers.expiry === undefined,
      error: draft.hasNotifier ? undefined : NO_NOTIFIER,
    },
    name: {
      id: "name",
      question: "Name your alert",
      allowSkip: false,
      fields: [
        {
          id: "name",
          ariaLabel: "Name",
          live: true,
          current: draft.name,
          parse: (text) => text.trim() || undefined,
          onSubmit: draft.setEditedName,
        },
      ],
      options: continueOption(draft.name.trim() ? undefined : "Enter a name"),
      selected: done("name") ? [CONTINUE_OPTION] : [],
    },
  };
  const steps = ids.map((id) => stepsById[id]!);
  const stepIndex = Math.max(0, ids.indexOf(stepId));

  function select(id: string, value: string) {
    switch (id) {
      case "signal": {
        draft.setSignalId(value);
        const signal = signals.find((s) => s.id === value);
        const modes = queryConditionModes(analysis, signal);
        advance(id, modes.includes(mode) ? mode : modes[0]);
        return;
      }
      case "condition":
        draft.setModeChoice(value as QueryAlertMode);
        advance(id, value as QueryAlertMode);
        return;
      case "threshold":
        if (!draft.valueValid) return;
        draft.setOperator(value as ">" | "<");
        advance(id);
        return;
      case "expiry":
        draft.selectStep(id, value);
        if (value !== CUSTOM_EXPIRY) advance(id);
        return;
      case "notifiers":
        draft.selectStep(id, value);
        return;
      default:
        advance(id);
    }
  }

  return { steps, stepIndex, setStepId, select, advance, startOver };
}

function QueryAlertChat({
  prefill,
  header,
  alertDetailPath,
  onNewChat,
  onCreated,
  environmentTitle,
  chat,
}: {
  prefill: QueryAlertPrefill;
  header: ReactNode;
  alertDetailPath: (alertId: string) => string;
  onNewChat?: () => void;
  onCreated?: (info: QueryAlertCreated) => void;
  environmentTitle?: string;
  chat?: QueryAlertChat;
}) {
  const [created, setCreated] = useState<{ id?: string }>();
  const draft = useQueryAlertDraft(
    prefill,
    (id, chatId, name) => {
      setCreated({ id });
      onCreated?.({ alertId: id, chatId, name });
    },
    chat
  );
  const { analysis, flow } = draft;
  const [reviewing, setReviewing] = useState(false);
  const [closed, setClosed] = useState(false);
  const wizard = useQueryAlertWizard(draft, prefill, { onDone: () => setReviewing(true) });
  const { steps, stepIndex, setStepId, select, advance } = wizard;
  const startOver = () => {
    wizard.startOver();
    setReviewing(false);
    setClosed(false);
  };

  const fields = queryReviewFields(draft, environmentTitle);
  const expiry = flow.answers.expiry;
  const createdBlock = created
    ? alertCreatedBlock(created.id ?? "", {
        ...fields,
        ...(isExpiryTimestamp(expiry)
          ? { expiresAt: new Date(expiry!).toISOString() }
          : { expiryLabel: expiryLabel(expiry) }),
      })
    : undefined;

  return (
    <>
      <ChatTranscript>
        <div data-testid="query-alert-flow" className="flex flex-col gap-3">
          {header}
          {reviewing && !created ? (
            <ChatTurn speaker="assistant">
              <div data-testid="query-alert-review" className="flex flex-col gap-2">
                <WatchStyleReviewCard
                  fields={fields}
                  actions={{
                    onCreate: () => void draft.create(),
                    submitting: draft.submitting,
                    createDisabled: !draft.canCreate,
                    onPreview: () => void draft.runPreview(),
                    previewDisabled: !draft.canPreview || draft.previewing,
                    onCustomize: () => {
                      setReviewing(false);
                      setClosed(false);
                    },
                    onStartOver: onNewChat ?? startOver,
                  }}
                  detail={<QueryBlock query={prefill.query} />}
                />
                {draft.preview ? (
                  <QueryPreviewResult
                    outcome={draft.preview}
                    detailRows={analysis.limits.detailRows}
                  />
                ) : null}
                {draft.createError ? <Callout variant="error">{draft.createError}</Callout> : null}
              </div>
            </ChatTurn>
          ) : null}
          {created && createdBlock ? (
            <ChatTurn speaker="assistant">
              <ChatText speaker="assistant" text={REVIEW_MESSAGE} />
              <AlertCreatedCard
                block={createdBlock}
                alertDetailPath={created.id ? alertDetailPath(created.id) : undefined}
              />
            </ChatTurn>
          ) : null}
          {closed && !reviewing && !created ? (
            <ChatTurn speaker="assistant">
              <Button variant="secondary/small" onClick={() => setClosed(false)}>
                Continue
              </Button>
            </ChatTurn>
          ) : null}
        </div>
      </ChatTranscript>
      {draft.addingChannel ? (
        <AlertChannelsDialog
          open
          onCreated={(channel) => {
            if (!flow.answers.notifiers?.includes(channel.id)) flow.toggleNotifier(channel.id);
          }}
          onClose={() => {
            draft.setAddingChannel(false);
            draft.addChannel.onCreated();
          }}
        />
      ) : null}
      <div className="relative shrink-0">
        {!closed && !reviewing && !created ? (
          <div className="absolute inset-x-3 bottom-full z-10 mb-1">
            <ChatWizardCard
              steps={steps}
              stepIndex={stepIndex}
              onStepChange={(index) => setStepId(steps[index]?.id ?? "query")}
              onSelect={select}
              onSkip={() => {}}
              onClose={() => setClosed(true)}
              onConfirm={(id) => advance(id)}
            />
          </div>
        ) : null}
        {onNewChat ? (
          <div className="flex items-center justify-end px-3 pb-3 pt-1">
            <NewChatButton onClick={onNewChat} />
          </div>
        ) : null}
      </div>
    </>
  );
}
