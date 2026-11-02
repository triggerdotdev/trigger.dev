import type { ReactNode } from "react";
import { AlertChannelsDialog } from "~/components/alerts/AlertChannelsDialog";
import {
  QUERY_CONDITION_LABELS,
  querySignalOptions,
  watchBlockedReasons,
  type QueryAlertMode,
  type QueryAlertPrefill,
} from "~/components/alerts/queryAlertLink";
import { QueryBlock } from "~/components/alerts/QueryBlock";
import { QueryPreviewResult } from "~/components/alerts/QueryPreviewResult";
import { useQueryAlertDraft } from "~/components/alerts/useQueryAlertDraft";
import { NO_NOTIFIER } from "~/components/alerts/wizardSteps";
import { ManualStep } from "~/components/dashboard-agent/alert-creation/ManualCreationForm";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { Input } from "~/components/primitives/Input";
import { Select, SelectItem } from "~/components/primitives/Select";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { queryPath } from "~/utils/pathBuilder";

const SINGLE_FIELD = "w-full max-w-[372px]";
const OPERATORS = [
  { id: ">", label: ">" },
  { id: "<", label: "<" },
];

type Choice = { id: string; label: string };

function Section({
  id,
  title,
  hint,
  children,
}: {
  id: string;
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <fieldset data-step={id} className="flex flex-col gap-1.5">
      <legend className="pb-1.5 text-sm text-text-bright">{title}</legend>
      {children}
      {hint ? <p className="text-xs text-text-dimmed">{hint}</p> : null}
    </fieldset>
  );
}

function ChoiceSelect({
  label,
  value,
  options,
  onChange,
  className = SINGLE_FIELD,
}: {
  label: string;
  value: string;
  options: Choice[];
  onChange: (value: string) => void;
  className?: string;
}) {
  return (
    <Select
      aria-label={label}
      variant="secondary/small"
      dropdownIcon
      className={className}
      popoverClassName="min-w-27"
      value={value}
      setValue={(next: string | string[]) => {
        const picked = Array.isArray(next) ? next[0] : next;
        if (picked) onChange(picked);
      }}
      text={(current: string | string[]) => options.find((option) => option.id === current)?.label}
      items={options}
    >
      {(list) =>
        list.map((item) => (
          <SelectItem
            key={item.id}
            value={item.id}
            checkPosition="right"
            className="text-text-bright"
          >
            {item.label}
          </SelectItem>
        ))
      }
    </Select>
  );
}

function QueryAlertUnavailable({ reasons }: { reasons: string[] }) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  return (
    <div data-testid="query-alert-unavailable" className="flex flex-col gap-3">
      <Callout variant="warning">
        {reasons.map((reason) => (
          <p key={reason}>{reason}</p>
        ))}
      </Callout>
      <LinkButton
        variant="secondary/small"
        to={queryPath(organization, project, environment)}
        className="w-fit"
      >
        Back to query
      </LinkButton>
    </div>
  );
}

export function QueryAlertForm({
  prefill,
  onCreated,
}: {
  prefill: QueryAlertPrefill;
  onCreated: (alertId: string | undefined) => void;
}) {
  const reasons = watchBlockedReasons(prefill.analysis, prefill.query);
  if (reasons.length || querySignalOptions(prefill.analysis).length === 0) {
    return <QueryAlertUnavailable reasons={reasons} />;
  }
  return <QueryAlertFields prefill={prefill} onCreated={onCreated} />;
}

function QueryAlertFields({
  prefill,
  onCreated,
}: {
  prefill: QueryAlertPrefill;
  onCreated: (alertId: string | undefined) => void;
}) {
  const draft = useQueryAlertDraft(prefill, onCreated);
  const {
    analysis,
    signals,
    signal,
    setSignalId,
    modes,
    mode,
    setModeChoice,
    operator,
    setOperator,
    valueText,
    setValueText,
    bounds,
    windowText,
    setWindowText,
    windowValid,
    name,
    setEditedName,
    flow,
    addChannel,
    addingChannel,
    setAddingChannel,
    expiryStep,
    notifiersStep,
    hasNotifier,
    selectStep,
  } = draft;

  return (
    <div data-testid="query-alert-form" className="flex flex-col gap-4">
      <Section id="query" title="Query">
        <QueryBlock query={prefill.query} />
      </Section>
      {signals.length > 1 ? (
        <Section id="signal" title="Signal">
          <ChoiceSelect label="Signal" value={signal.id} options={signals} onChange={setSignalId} />
        </Section>
      ) : null}
      <Section id="condition" title="Condition">
        {modes.length > 1 ? (
          <ChoiceSelect
            label="Condition"
            value={mode}
            options={modes.map((m) => ({ id: m, label: QUERY_CONDITION_LABELS[m] }))}
            onChange={(next) => setModeChoice(next as QueryAlertMode)}
          />
        ) : (
          <p className="text-sm text-text-bright">{QUERY_CONDITION_LABELS[mode]}</p>
        )}
        {mode === "threshold" ? (
          <div className={`flex items-center gap-2 ${SINGLE_FIELD}`}>
            <ChoiceSelect
              label="Operator"
              value={operator}
              options={OPERATORS}
              onChange={(next) => setOperator(next as ">" | "<")}
              className="w-16 shrink-0"
            />
            <Input
              variant="small"
              type="number"
              inputMode="decimal"
              aria-label="Threshold"
              placeholder="1000"
              containerClassName="min-w-0 flex-1"
              value={valueText}
              onChange={(e) => setValueText(e.target.value)}
            />
          </div>
        ) : null}
      </Section>
      {mode === "match" ? null : (
        <Section
          id="window"
          title="Window"
          hint={`At least ${bounds.min} min, at most ${bounds.max} min.`}
        >
          <div className={`flex items-center gap-2 ${SINGLE_FIELD}`}>
            <Input
              variant="small"
              type="number"
              inputMode="numeric"
              aria-label="Window"
              containerClassName={`min-w-0 flex-1 ${windowValid ? "" : "border-error"}`}
              value={windowText}
              onChange={(e) => setWindowText(e.target.value)}
            />
            <span className="w-10 shrink-0 text-xs text-text-dimmed">min</span>
          </div>
        </Section>
      )}
      <ManualStep step={expiryStep} onSelect={selectStep} />
      <ManualStep
        step={{ ...notifiersStep, error: hasNotifier ? undefined : NO_NOTIFIER }}
        onSelect={selectStep}
      />
      <Section id="name" title="Name your alert">
        <Input
          variant="small"
          aria-label="Name"
          containerClassName={SINGLE_FIELD}
          value={name}
          onChange={(e) => setEditedName(e.target.value)}
        />
      </Section>
      {draft.preview ? (
        <QueryPreviewResult outcome={draft.preview} detailRows={analysis.limits.detailRows} />
      ) : null}
      {draft.createError ? <Callout variant="error">{draft.createError}</Callout> : null}
      <div className="flex justify-end gap-2">
        <Button
          variant="secondary/small"
          disabled={!draft.canPreview || draft.previewing}
          onClick={() => void draft.runPreview()}
        >
          Preview
        </Button>
        <Button
          variant="primary/small"
          disabled={!draft.canCreate || draft.submitting}
          onClick={() => void draft.create()}
        >
          Create alert
        </Button>
      </div>
      {addingChannel ? (
        <AlertChannelsDialog
          open
          onCreated={(channel) => {
            if (!flow.answers.notifiers?.includes(channel.id)) flow.toggleNotifier(channel.id);
          }}
          onClose={() => {
            setAddingChannel(false);
            addChannel.onCreated();
          }}
        />
      ) : null}
    </div>
  );
}
