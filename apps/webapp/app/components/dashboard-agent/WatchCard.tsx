/**
 * The watch configuration card, opened by the Watch action.
 *
 * Rules it keeps: the card is ephemeral until submitted (it lives in the panel,
 * not the transcript, and only a submitted outcome is persisted as a
 * `watch_result` block); Customize expands in place, never a modal; in-chat
 * delivery is stated as a line, so the two opt-ins stay independent checkboxes
 * and never become a radio group.
 *
 * Pure component: draft in, markup and callbacks out. Draft rules live in
 * `watch-card.ts` and wording in `app/presenters/v3/dashboardAgent`.
 */
import {
  WATCH_WINDOW_HOURS_OPTIONS,
  watchCadenceOptions,
  type WatchDraft,
  type WatchKind,
} from "@internal/dashboard-agent-contracts";
import { useId, useState } from "react";
import { AgentMonoLogo } from "~/components/primitives/AgentDotMatrix";
import { Button } from "~/components/primitives/Buttons";
import { Checkbox } from "~/components/primitives/Checkbox";
import { Input } from "~/components/primitives/Input";
import { AgentSpinner } from "~/components/primitives/Spinner";
import { cn } from "~/utils/cn";
import { ChatSystemBlock } from "./chat-layout";
import {
  variantsOf,
  watchDraftError,
  withAgeMinutes,
  withCadence,
  withFollowUp,
  withThreshold,
  withVariant,
  withWindow,
} from "./watch-card";
import {
  formatWatchCadence,
  formatWatchWindow,
  WATCH_IN_CHAT_DELIVERY_LINE,
  watchConditionLabel,
  watchDurationLabel,
  watchSubjectLabel,
} from "~/presenters/v3/dashboardAgent";

/** How the condition variants are named in the picker. Short, not sentences. */
const VARIANT_LABEL: Record<WatchKind, string> = {
  run_start: "when it starts",
  run_finished: "when it finishes",
  run_failed: "if it fails",
  backlog_drain: "when it drains",
  queue_depth_above: "if it grows",
  queue_depth_below: "when it's back below",
  queue_stalled: "if it stops moving",
  queue_oldest_age: "if runs wait too long",
  error_recurrence: "if it recurs",
  health_recovery: "when it recovers",
};

/** Hoisted so the submit button's icon component keeps a stable identity. */
function ButtonSpinner() {
  return <AgentSpinner size={14} />;
}

/** Controlled, unlike `CheckboxWithLabel`: the draft is the only thing that says what's on. */
function Toggle({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <div className={cn("group flex w-fit items-start gap-x-2", disabled && "opacity-70")}>
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-1"
      />
      <label
        htmlFor={id}
        className={cn(
          "mt-0.5 select-none text-sm text-text-bright",
          disabled ? "cursor-default" : "cursor-pointer"
        )}
      >
        {label}
      </label>
    </div>
  );
}

/** One choice in an inline picker. */
function Choice({
  selected,
  disabled,
  onSelect,
  children,
}: {
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "rounded-full border px-2 py-0.5 text-xs transition focus-custom",
        selected
          ? "border-border-brightest bg-background-bright text-text-bright"
          : "border-border-bright text-text-dimmed hover:text-text-bright",
        disabled && "cursor-default opacity-70 hover:text-text-dimmed"
      )}
    >
      {children}
    </button>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xxs uppercase tracking-wide text-text-faint">{label}</span>
      <div className="flex flex-wrap items-center gap-1">{children}</div>
    </div>
  );
}

export function WatchCard({
  draft,
  onChange,
  onSubmit,
  onCancel,
  /** Start expanded: the gallery's Customize state, and a free-text pre-fill. */
  defaultExpanded = false,
  /** The submit is in flight: the card stays, disabled, so nothing moves. */
  pending = false,
  /** A refusal from the server (cap, duplicate, network). */
  error,
}: {
  draft: WatchDraft;
  onChange: (draft: WatchDraft) => void;
  onSubmit: () => void;
  onCancel?: () => void;
  defaultExpanded?: boolean;
  pending?: boolean;
  error?: string | null;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const { spec } = draft;
  const variants = variantsOf(draft);
  // Local validation first: a draft the schema would refuse never reaches the server.
  const localError = watchDraftError(draft);
  const blocked = localError !== null || pending;

  return (
    <ChatSystemBlock
      label="Watch"
      icon={<AgentMonoLogo size={14} decorative />}
      actions={
        <>
          {/* One confirm, expanded or not: an expanded card is submitted as shown. */}
          <Button
            variant="primary/small"
            disabled={blocked}
            LeadingIcon={pending ? ButtonSpinner : undefined}
            onClick={onSubmit}
          >
            {pending ? "Starting…" : "Watch"}
          </Button>
          {!expanded ? (
            <Button
              variant="minimal/small"
              disabled={pending}
              aria-expanded={expanded}
              onClick={() => setExpanded(true)}
            >
              Customize
            </Button>
          ) : null}
          {onCancel ? (
            <Button variant="minimal/small" disabled={pending} onClick={onCancel}>
              Cancel
            </Button>
          ) : null}
        </>
      }
    >
      <p className="truncate text-sm font-medium text-text-bright">
        Watch {watchSubjectLabel(spec)}
      </p>
      {!expanded ? (
        <>
          <p className="text-xs text-text-dimmed">{watchConditionLabel(spec)}</p>
          <p className="text-xs text-text-dimmed">{watchDurationLabel(spec)}</p>
        </>
      ) : null}
      <p className="text-xs text-text-dimmed">{WATCH_IN_CHAT_DELIVERY_LINE}</p>

      {expanded ? (
        <div className="flex flex-col gap-3 pt-2">
          {/* Kinds with no second condition variant must not show an empty picker. */}
          {variants.length > 1 ? (
            <Field label="Tell me">
              {variants.map((kind) => (
                <Choice
                  key={kind}
                  selected={kind === spec.kind}
                  disabled={pending}
                  onSelect={() => {
                    if (kind !== spec.kind) onChange(withVariant(draft, kind));
                  }}
                >
                  {VARIANT_LABEL[kind]}
                </Choice>
              ))}
            </Field>
          ) : (
            <Field label="Tell me">
              <span className="text-xs text-text-dimmed">{watchConditionLabel(spec)}</span>
            </Field>
          )}

          {/* One contextual parameter per condition, only where one exists. */}
          {spec.kind === "queue_depth_above" || spec.kind === "queue_depth_below" ? (
            <Field label={spec.kind === "queue_depth_above" ? "Above" : "Below"}>
              <Input
                type="number"
                min={0}
                variant="small"
                className="w-28"
                disabled={pending}
                // A half-typed field must show empty, not "NaN"; `watchDraftError`
                // is what refuses to submit it.
                value={Number.isFinite(spec.threshold) ? String(spec.threshold) : ""}
                onChange={(event) =>
                  onChange(withThreshold(draft, Number.parseInt(event.target.value, 10)))
                }
                aria-label="Queue depth threshold"
              />
            </Field>
          ) : null}

          {spec.kind === "queue_oldest_age" ? (
            <Field label="Waiting longer than">
              <Input
                type="number"
                min={1}
                variant="small"
                className="w-28"
                disabled={pending}
                value={Number.isFinite(spec.thresholdMinutes) ? String(spec.thresholdMinutes) : ""}
                onChange={(event) =>
                  onChange(withAgeMinutes(draft, Number.parseInt(event.target.value, 10)))
                }
                aria-label="Wait limit in minutes"
              />
              <span className="text-xs text-text-dimmed">minutes</span>
            </Field>
          ) : null}

          <Field label="For">
            {WATCH_WINDOW_HOURS_OPTIONS.map((hours) => (
              <Choice
                key={hours}
                selected={spec.maxHours === hours}
                disabled={pending}
                onSelect={() => onChange(withWindow(draft, hours))}
              >
                {formatWatchWindow(hours)}
              </Choice>
            ))}
          </Field>

          {/* Cadence options come from the kind's schema limits, so an aggregate
              watch can never be offered a 1-minute hot loop. */}
          <Field label="Checking">
            {watchCadenceOptions(spec.kind).map((minutes) => (
              <Choice
                key={minutes}
                selected={spec.checkEveryMinutes === minutes}
                disabled={pending}
                onSelect={() => onChange(withCadence(draft, minutes))}
              >
                {formatWatchCadence(minutes)}
              </Choice>
            ))}
          </Field>

          {/* Two independent opt-ins under a fixed delivery line, never a radio
              group, so "email instead of chat" is not expressible. */}
          <Field label="When there's an answer">
            <div className="flex flex-col gap-1.5">
              <Toggle
                label="Investigate attention outcomes"
                checked={draft.followUp.investigateOnAttention}
                disabled={pending}
                onChange={(checked) =>
                  onChange(withFollowUp(draft, { investigateOnAttention: checked }))
                }
              />
              <Toggle
                label="Also notify me externally"
                checked={draft.followUp.notifyExternally}
                disabled={pending}
                onChange={(checked) => onChange(withFollowUp(draft, { notifyExternally: checked }))}
              />
            </div>
          </Field>
        </div>
      ) : null}

      {/* Errors live and die with the card: nothing is persisted. */}
      {localError || error ? (
        <p className="pt-1 text-xs text-error">{localError ?? error}</p>
      ) : null}
    </ChatSystemBlock>
  );
}
