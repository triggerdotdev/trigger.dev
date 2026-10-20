import { ChevronDownIcon, PlusIcon } from "@heroicons/react/20/solid";
import { useFetcher } from "@remix-run/react";
import { useEffect, useRef, useState } from "react";
import { AlertChannelsDialog } from "~/components/alerts/AlertChannelsDialog";
import { errorGroupResolver, type ErrorGroupOption } from "~/components/alerts/errorGroupOptions";
import { useErrorGroupLookup } from "~/components/alerts/useErrorGroupLookup";
import { ScopeEntitiesLoader, type ScopeEntities } from "~/components/alerts/ScopeEntitiesLoader";
import { AlertCreatedCard, WatchStyleReviewCard } from "~/components/alerts/creationCards";
import { shownCreatedBlock } from "~/components/alerts/alertCreatedCard";
import {
  allSteps,
  applyStepSelection,
  buildCreatedFields,
  buildReviewFields,
  cardPosition,
  confirmStep,
  CONTINUE_OPTION,
  ADD_CHANNEL_OPTION,
  NO_NOTIFIER,
  SHOW_ALL_CHIP,
  type AddChannelAccess,
} from "~/components/alerts/wizardSteps";
import {
  InputRow,
  type ChatWizardInput,
  type ChatWizardStep,
  StepDescription,
} from "~/components/dashboard-agent/ChatWizardCard";
import { Button, ButtonContent } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { Icon } from "~/components/primitives/Icon";
import { Select, SelectItem } from "~/components/primitives/Select";
import { useOptionalEnvironment } from "~/hooks/useEnvironment";
import { useOptionalOrganization } from "~/hooks/useOrganizations";
import { useOptionalProject } from "~/hooks/useProject";
import { cn } from "~/utils/cn";
import { parseErrorGroupScope } from "~/utils/errorGroupScope";
import { v3EnvironmentPath } from "~/utils/pathBuilder";
import type { AlertChannel, CreationFlowState } from "./CreationFlow";
import { isErrorGroupOnly, scopeEntityKindFor } from "./flow-state";

const CUSTOM_VALUE = "__custom__";
const REPLACE_EDITABLE = ["environments", "expiry", "notifiers"];

const SINGLE_FIELD = "w-full max-w-[372px]";

function UnitInput({
  input,
  autoFocus,
  stacked,
  onValidity,
  onClose,
}: {
  input: ChatWizardInput;
  autoFocus?: boolean;
  stacked?: boolean;
  onValidity: (valid: boolean) => void;
  onClose?: () => void;
}) {
  return (
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Esc and Backspace from the input inside
    <li
      onKeyDown={(e) => {
        if (!onClose) return;
        const emptyDelete =
          (e.key === "Backspace" || e.key === "Delete") &&
          e.target instanceof HTMLInputElement &&
          !e.target.value;
        if (e.key !== "Escape" && !emptyDelete) return;
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
      className={`grid grid-cols-[minmax(0,1fr)_2.5rem] items-start gap-2 ${SINGLE_FIELD}`}
    >
      <ul className="w-full min-w-0">
        <InputRow
          input={input}
          autoFocus={autoFocus}
          stacked={stacked}
          className="p-0"
          fieldClassName="w-full min-w-0"
          onValidity={onValidity}
        />
      </ul>
      {input.unit ? (
        <span
          className={`flex h-6 w-10 shrink-0 items-center justify-start text-xs text-text-dimmed ${stacked ? "mt-6" : ""}`}
        >
          {input.unit}
        </span>
      ) : null}
    </li>
  );
}

function ChannelCheckboxes({
  step,
  onSelect,
}: {
  step: ChatWizardStep;
  onSelect: (stepId: string, optionId: string) => void;
}) {
  const adding = step.options.find((option) => option.id === ADD_CHANNEL_OPTION);
  return (
    <li>
      <ul data-checkbox-list className="flex flex-col gap-1.5 mt-1">
        {step.options
          .filter((option) => option.id !== ADD_CHANNEL_OPTION)
          .map((option) =>
            option.expanded !== undefined ? (
              <li key={option.id}>
                <button
                  type="button"
                  aria-expanded={option.expanded}
                  onClick={() => onSelect(step.id, option.id)}
                  className="group/expand flex w-fit items-center gap-2 text-sm text-text-bright"
                >
                  {option.icon ? <Icon icon={option.icon} className="size-4 shrink-0" /> : null}
                  {option.label}
                  <ChevronDownIcon
                    data-expander
                    className={cn(
                      "size-4 shrink-0 text-text-dimmed transition-transform",
                      !option.expanded && "-rotate-90"
                    )}
                  />
                </button>
              </li>
            ) : (
              <li key={option.id}>
                <label className="flex w-fit cursor-pointer items-center gap-2 text-sm text-text-bright">
                  <input
                    type="checkbox"
                    checked={step.selected?.includes(option.id) ?? false}
                    onChange={() => onSelect(step.id, option.id)}
                    className="cursor-pointer rounded-sm border border-border-bright bg-transparent checked:bg-indigo-500! focus:ring-1 focus:ring-indigo-500 focus:ring-offset-0"
                  />
                  {option.icon ? <Icon icon={option.icon} className="size-4 shrink-0" /> : null}
                  {option.label}
                </label>
              </li>
            )
          )}
      </ul>
      {adding ? (
        <button
          type="button"
          className="group/button outline-hidden focus-custom mt-3"
          disabled={Boolean(adding.disabledReason)}
          onClick={() => onSelect(step.id, adding.id)}
        >
          <ButtonContent variant="secondary/small" LeadingIcon={PlusIcon}>
            {adding.label}
          </ButtonContent>
        </button>
      ) : null}
    </li>
  );
}

function ManualStep({
  step,
  onSelect,
  onConfirm,
  footer,
  locked,
  revealed,
}: {
  step: ChatWizardStep & { picking?: boolean };
  onSelect: (stepId: string, optionId: string) => void;
  onConfirm?: () => void;
  footer?: React.ReactNode;
  locked?: boolean;
  revealed?: boolean;
}) {
  const fieldsetRef = useRef<HTMLFieldSetElement>(null);
  const [editing, setEditing] = useState(false);
  const [invalid, setInvalid] = useState<Record<string, boolean>>({});
  const blocked = Object.values(invalid).some(Boolean);
  const customId = step.customOption ?? CUSTOM_VALUE;
  const customOpen = Boolean(
    step.custom && (step.custom.open || editing || step.selected?.includes(customId))
  );
  const inPlaceCustom = Boolean(
    step.custom?.numeric && !step.customOption && customOpen && step.id !== "condition"
  );
  const revealCustom = () => {
    if (!step.custom) return;
    const trigger = fieldsetRef.current?.querySelector('button[role="combobox"]');
    if (trigger?.getAttribute("aria-expanded") !== "true") return;
    step.onReveal?.();
    setEditing(true);
  };
  const keepOpenOnClear = () => {
    setEditing(true);
    step.custom?.onClear?.();
  };
  const closeCustom = () => {
    setEditing(false);
    step.onReveal?.();
  };
  const entity = step.entity;
  const entityCustom = Boolean(entity?.custom);
  const baseItems =
    (step.custom && !step.customOption) || (entityCustom && !step.custom)
      ? [...step.options, { id: CUSTOM_VALUE, label: "Custom" }]
      : step.options;
  const items = entity ? [...baseItems, ...entity.options] : baseItems;
  const value =
    editing && customOpen
      ? customId
      : entityCustom
        ? customId
        : (entity?.selected ?? step.selected?.[0] ?? "");
  const selectValue: string | string[] = step.multiSelect ? (step.selected ?? []) : value;
  const report = (key: string) => (valid: boolean) =>
    setInvalid((prev) => (prev[key] === !valid ? prev : { ...prev, [key]: !valid }));

  const sole =
    step.options.length === 1 && !step.custom && !step.entity && !step.multiSelect
      ? step.options[0]
      : undefined;
  const autoPick =
    sole && sole.id !== CONTINUE_OPTION && !sole.disabledReason && !step.selected?.includes(sole.id)
      ? sole.id
      : entity &&
          !entityCustom &&
          !step.custom &&
          !entity.selected &&
          !step.picking &&
          !step.selected?.length
        ? step.options[0]?.id
        : undefined;
  const showSelect =
    !inPlaceCustom && !sole && !(step.options.length === 0 && !step.custom && !step.placeholder);
  const checkboxes = Boolean(step.multiSelect);
  useEffect(() => {
    if (autoPick && !locked) onSelect(step.id, autoPick);
  }, [autoPick, locked]); // eslint-disable-line react-hooks/exhaustive-deps -- select once per sole option

  const dateOpen = step.custom?.type === "date" && customOpen;
  const wasDateOpen = useRef(dateOpen);
  useEffect(() => {
    if (dateOpen && !wasDateOpen.current) {
      fieldsetRef.current
        ?.querySelector<HTMLElement>('[role="group"] [role="spinbutton"]')
        ?.focus();
    }
    wasDateOpen.current = dateOpen;
  }, [dateOpen]);

  return (
    <fieldset
      ref={fieldsetRef}
      data-step={step.id}
      disabled={locked}
      className="flex flex-col gap-1.5"
    >
      <legend className="pb-1.5 text-sm text-text-bright">{step.question}</legend>
      {step.description ? (
        <p className="text-xs text-text-dimmed">
          <StepDescription step={step} />
        </p>
      ) : null}
      <ul className="flex flex-col gap-1.5">
        {checkboxes ? <ChannelCheckboxes step={step} onSelect={onSelect} /> : null}
        {checkboxes ? null : (
          <li>
            <ul className="flex flex-col gap-1.5">
              {!showSelect ? null : (
                <li>
                  <Select
                    aria-label={step.question}
                    variant="secondary/small"
                    dropdownIcon
                    className={SINGLE_FIELD}
                    popoverClassName="min-w-27"
                    disabled={blocked || step.selectDisabled}
                    value={selectValue}
                    setValue={(next: string | string[]) => {
                      if (step.multiSelect) return;
                      const picked = Array.isArray(next) ? next[0] : next;
                      if (!picked) return;
                      if (entity?.options.some((o) => o.id === picked)) {
                        setEditing(false);
                        entity.onSelect(picked);
                      } else if (picked !== customId) {
                        setEditing(false);
                        onSelect(step.id, picked);
                      }
                    }}
                    text={(current: string | string[]) => {
                      if (Array.isArray(current)) {
                        return (
                          current
                            .map((id) => step.options.find((o) => o.id === id)?.label ?? id)
                            .join(", ") || undefined
                        );
                      }
                      return current === CUSTOM_VALUE
                        ? "Custom"
                        : (items.find((o) => o.id === current)?.label ?? (current || undefined));
                    }}
                    placeholder={
                      step.id === "condition"
                        ? "Select…"
                        : (entity?.placeholder ?? step.placeholder ?? "Select…")
                    }
                    items={items}
                    filter={
                      entity?.onSearch
                        ? (item, search) =>
                            entity.options.some((o) => o.id === item.id) &&
                            item.label.toLowerCase().includes(search.trim().toLowerCase())
                        : undefined
                    }
                    onSearchChange={entity?.onSearch}
                  >
                    {(list) =>
                      list.map((item) => (
                        <SelectItem
                          key={item.id}
                          value={item.id}
                          checkPosition={step.multiSelect ? "left" : "right"}
                          disabled={Boolean(item.disabledReason)}
                          title={item.disabledReason}
                          className="text-text-bright"
                          {...(item.id === customId && !step.multiSelect
                            ? { setValueOnClick: false, hideOnClick: true, onClick: revealCustom }
                            : {})}
                          {...(step.multiSelect
                            ? {
                                setValueOnClick: false,
                                hideOnClick: item.id === ADD_CHANNEL_OPTION,
                                onClick: () => onSelect(step.id, item.id),
                              }
                            : {})}
                          icon={
                            item.icon ? (
                              <Icon
                                icon={item.icon}
                                className="mr-1 size-4 shrink-0 text-text-dimmed"
                              />
                            ) : undefined
                          }
                        >
                          {item.label}
                        </SelectItem>
                      ))
                    }
                  </Select>
                </li>
              )}
              {step.custom && customOpen ? (
                <UnitInput
                  key={`${step.id}:${step.custom.id}`}
                  input={
                    (inPlaceCustom || step.id === "condition") && step.custom.numeric
                      ? { ...step.custom, placeholder: "1000" }
                      : step.custom.onClear
                        ? { ...step.custom, onClear: keepOpenOnClear }
                        : step.custom
                  }
                  autoFocus={!inPlaceCustom || editing || revealed}
                  onValidity={report(step.custom.id)}
                  onClose={inPlaceCustom ? closeCustom : undefined}
                />
              ) : null}
              {entity?.custom && !step.custom ? (
                <UnitInput
                  key={`${entity.id}:custom`}
                  input={entity.custom}
                  onValidity={report(entity.custom.id)}
                />
              ) : null}
            </ul>
          </li>
        )}
        {step.fields ? (
          <li>
            <ul className="flex flex-col gap-2">
              {step.fields.map((field, index) => (
                <UnitInput
                  key={field.id}
                  input={field}
                  stacked
                  autoFocus={revealed && index === 0}
                  onValidity={report(field.id)}
                />
              ))}
            </ul>
          </li>
        ) : null}
        {step.selectedDescription ? (
          <li className="text-xs text-text-dimmed">{step.selectedDescription}</li>
        ) : null}
        {step.hint ? <li className="text-xs text-text-dimmed">{step.hint}</li> : null}
        {step.error ? (
          <li role="alert" className="text-xxs text-error">
            {step.error}
          </li>
        ) : null}
        {step.multiSelect && onConfirm ? (
          <li className="flex justify-end pt-2">
            <Button
              variant="primary/small"
              disabled={!step.selected?.length || blocked || step.confirmDisabled}
              onClick={onConfirm}
            >
              {step.confirmLabel ?? "Done"}
            </Button>
          </li>
        ) : null}
      </ul>
      {footer}
    </fieldset>
  );
}

function ErrorGroupsLoader({
  onUrl,
  onLoad,
}: {
  onUrl: (url: string | undefined) => void;
  onLoad: (url: string, groups: ErrorGroupOption[]) => void;
}) {
  const organization = useOptionalOrganization();
  const project = useOptionalProject();
  const environment = useOptionalEnvironment();
  const fetcher = useFetcher<{ groups: ErrorGroupOption[] }>();
  const url =
    organization && project && environment
      ? `/resources${v3EnvironmentPath(organization, project, environment)}/alerts/error-groups`
      : undefined;

  useEffect(() => {
    onUrl(url);
    if (url) fetcher.load(url);
  }, [url]); // eslint-disable-line react-hooks/exhaustive-deps -- load once per url; fetcher and callbacks change identity every render

  useEffect(() => {
    if (fetcher.data && url) onLoad(url, fetcher.data.groups);
  }, [fetcher.data]); // eslint-disable-line react-hooks/exhaustive-deps -- report each response once

  return null;
}

export function ManualCreationForm({
  flow,
  channels,
  chatId,
  addChannel,
  emptyAreas,
  onStartOver,
  alertDetailPath,
  environmentTitle,
}: {
  flow: CreationFlowState;
  channels: AlertChannel[];
  chatId?: string;
  addChannel?: AddChannelAccess;
  emptyAreas?: string[];
  onStartOver?: () => void;
  alertDetailPath?: string;
  environmentTitle?: string;
}) {
  const formRef = useRef<HTMLDivElement>(null);
  const [addingChannel, setAddingChannel] = useState(false);
  const [customizing, setCustomizing] = useState(false);
  const allChannels = channels;
  const [groupsUrl, setGroupsUrl] = useState<string>();
  const [loadedGroups, setLoadedGroups] = useState<{ url: string; groups: ErrorGroupOption[] }>();
  const errorGroups = loadedGroups?.url === groupsUrl ? loadedGroups?.groups : undefined;
  const needsErrorGroups = flow.answers.area === "errors" && isErrorGroupOnly(flow.answers.what);
  const { lookup, lookupError } = useErrorGroupLookup(
    flow,
    groupsUrl ? errorGroupResolver(groupsUrl) : undefined
  );
  const entityKind = flow.answers.replace ? undefined : scopeEntityKindFor(flow.answers);
  const [entities, setEntities] = useState<ScopeEntities>();
  const [entitySearch, setEntitySearch] = useState("");
  const steps = allSteps(
    flow,
    allChannels,
    chatId,
    addChannel,
    { groups: errorGroups, lookup, lookupError },
    entities?.kind === entityKind ? entities?.names : undefined,
    emptyAreas,
    setEntitySearch
  ).map((step) => ({
    ...step,
    options: step.options.filter(
      (option) => option.id !== SHOW_ALL_CHIP.value && option.id !== step.entityOption
    ),
    picking: Boolean(step.entityOption && step.selected?.includes(step.entityOption)),
    selected: step.selected?.filter((id) => id !== step.entityOption),
    entity: step.entity && {
      ...step.entity,
      onSelect: (id: string) => {
        step.entity?.onPick?.();
        step.entity?.onSelect(id);
      },
    },
  }));
  const position = cardPosition(flow);
  const found = position ? steps.findIndex((step) => step.id === position) : -1;
  const reached = found < 0 ? steps.length : found;
  const [initialStepIds] = useState(() => new Set(steps.slice(0, reached + 1).map((s) => s.id)));
  const shownStep = useRef(position);
  const conditionFilled = Boolean(
    steps
      .find((step) => step.id === "condition" && step.fields)
      ?.selected?.includes(CONTINUE_OPTION)
  );
  const replacing = Boolean(flow.answers.replace);
  const autoConfirm =
    replacing && !flow.answers.environmentsConfirmed && Boolean(flow.answers.environments?.length);
  useEffect(() => {
    if (autoConfirm) confirmStep(flow, "environments");
  }, [autoConfirm]); // eslint-disable-line react-hooks/exhaustive-deps -- confirm once on open
  const { confirmCondition } = flow;
  useEffect(() => {
    if (position === "condition" && conditionFilled) confirmCondition();
  }, [position, conditionFilled, confirmCondition]);

  useEffect(() => {
    if (shownStep.current === position) return;
    shownStep.current = position;
    const next = formRef.current?.querySelector<HTMLElement>(`fieldset[data-step="${position}"]`);
    if (!next) return;
    // Filling the params advances the form; the caret stays in the field being typed.
    if (
      document.activeElement instanceof HTMLInputElement &&
      formRef.current
        ?.querySelector('fieldset[data-step="condition"]')
        ?.contains(document.activeElement)
    ) {
      return;
    }
    if (document.activeElement?.closest('fieldset[data-step="expiry"] [role="group"]')) return;
    next.scrollIntoView?.({ block: "nearest" });
    next.querySelector<HTMLElement>("button:not(:disabled), input")?.focus();
  }, [position]);
  const reviewFields = buildReviewFields(flow, allChannels, environmentTitle);
  const reviewShown = flow.isReview && Boolean(reviewFields) && !customizing;
  const createdBlock = shownCreatedBlock(
    flow,
    buildCreatedFields(flow, allChannels, environmentTitle)
  );
  const hasNotifier = steps
    .find((step) => step.id === "notifiers")
    ?.options.some((o) => !o.disabledReason && flow.answers.notifiers?.includes(o.id));

  function select(stepId: string, value: string) {
    if (stepId === "scope" && parseErrorGroupScope(value)) {
      flow.selectChip("scope", "errorGroup");
      flow.setScopeValue(value);
      return;
    }
    const step = steps.find((s) => s.id === stepId);
    if (!step?.multiSelect && step?.selected?.includes(value) && value !== CONTINUE_OPTION) return;
    applyStepSelection(flow, stepId, value, {
      onShowAll: () => {},
      onAddChannel: () => setAddingChannel(true),
    });
  }

  return (
    <div ref={formRef} data-testid="manual-form" className="flex flex-col gap-4">
      {needsErrorGroups && (
        <ErrorGroupsLoader
          onUrl={setGroupsUrl}
          onLoad={(url, groups) => setLoadedGroups({ url, groups })}
        />
      )}
      {entityKind && (
        <ScopeEntitiesLoader
          kind={entityKind}
          current={flow.answers.scopeValue}
          search={entitySearch}
          onLoad={setEntities}
        />
      )}
      {(replacing ? steps : steps.slice(0, reached + 1)).map((step) => (
        <ManualStep
          key={step.id}
          step={step}
          locked={reviewShown && !(replacing && REPLACE_EDITABLE.includes(step.id))}
          revealed={!initialStepIds.has(step.id)}
          onSelect={select}
          onConfirm={
            step.multiSelect && !reviewShown && !(replacing && step.id === "environments")
              ? () => {
                  setCustomizing(false);
                  confirmStep(flow, step.id);
                }
              : undefined
          }
        />
      ))}
      {flow.created && createdBlock ? (
        <AlertCreatedCard block={createdBlock} alertDetailPath={alertDetailPath} />
      ) : reviewShown && reviewFields ? (
        <WatchStyleReviewCard
          fields={reviewFields}
          actions={{
            onCreate: flow.create,
            onCustomize: () => {
              setCustomizing(true);
              formRef.current?.scrollIntoView?.({ block: "start" });
            },
            onStartOver: onStartOver ?? flow.reset,
            submitting: flow.submitting,
            blockedReason: hasNotifier ? undefined : NO_NOTIFIER,
          }}
        />
      ) : null}
      {flow.submitError && (
        <Callout variant="error">Failed to create the alert. Try again.</Callout>
      )}
      {addChannel && addingChannel && (
        <AlertChannelsDialog
          open
          onCreated={(channel) => {
            if (!flow.answers.notifiers?.includes(channel.id)) flow.toggleNotifier(channel.id);
          }}
          onClose={() => {
            setAddingChannel(false);
            addChannel.onCreated?.();
          }}
        />
      )}
    </div>
  );
}
