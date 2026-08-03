/**
 * The watch configuration card (§2.2) — the one thing the universal **Watch…**
 * action opens.
 *
 * Four rules it exists to keep:
 *
 * 1. **One block, not three pseudo-agent messages.** It renders as a system/form
 *    block (`ChatSystemBlock`), because it is deterministic UI and must not wear
 *    the agent's voice.
 * 2. **Ephemeral until submitted.** The card lives in the panel, not in the
 *    transcript. Abandoning it leaves no trace; validation and creation errors
 *    stay inside it; only a submitted outcome is persisted, by the server, as the
 *    `watch_result` block this card is replaced by.
 * 3. **Customize expands IN PLACE.** Same block, more of it — never a second
 *    surface, never a modal.
 * 4. **In-chat delivery is a fact, not a choice.** It is stated as a line. The
 *    two opt-ins beneath it are independent checkboxes and can never become a
 *    radio group, because there is no option to turn the chat off.
 *
 * PURE COMPONENT: draft in, markup and callbacks out. The draft's rules live in
 * `watch-card.ts` and the wording in `watch-presentation.ts`, so this file
 * decides layout and nothing else.
 */
import { EyeIcon } from "@heroicons/react/20/solid";
import {
  WATCH_WINDOW_HOURS_OPTIONS,
  watchCadenceOptions,
  type WatchDraft,
  type WatchKind,
} from "@internal/dashboard-agent-contracts";
import { useState } from "react";
import { Button } from "~/components/primitives/Buttons";
import { CheckboxWithLabel } from "~/components/primitives/Checkbox";
import { Input } from "~/components/primitives/Input";
import { AgentSpinner } from "~/components/primitives/Spinner";
import { cn } from "~/utils/cn";
import { ChatSystemBlock } from "./chat-layout";
import {
  variantOf,
  watchDraftError,
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
} from "./watch-presentation";

/** How the condition variants are named in the picker. Short, not sentences. */
const VARIANT_LABEL: Record<WatchKind, string> = {
  run_start: "when it starts",
  run_finished: "when it finishes",
  run_failed: "if it fails",
  backlog_drain: "when it drains",
  queue_depth_above: "if it grows",
  error_recurrence: "if it recurs",
  health_recovery: "when it recovers",
};

/** The in-flight glyph on the submit button. Hoisted so it keeps its identity. */
function ButtonSpinner() {
  return <AgentSpinner size={14} />;
}

/** One choice in an inline picker. Selected is the accent; the rest are quiet. */
function Choice({
  selected,
  onSelect,
  children,
}: {
  selected: boolean;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        "rounded-full border px-2 py-0.5 text-xs transition focus-custom",
        selected
          ? "border-border-brightest bg-background-bright text-text-bright"
          : "border-border-bright text-text-dimmed hover:text-text-bright"
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
  /** Start expanded — the gallery's Customize state, and a free-text pre-fill. */
  defaultExpanded = false,
  /** The submit is in flight: the card stays, disabled, so nothing moves. */
  pending = false,
  /** A refusal from the server (cap, duplicate, network). Stays in the card. */
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
  const variant = variantOf(draft);
  // Local validation first: a draft the schema would refuse never reaches the
  // server, and the same sentence appears whether it was caught here or there.
  const localError = watchDraftError(draft);
  const blocked = localError !== null || pending;

  return (
    <ChatSystemBlock
      label="Watch"
      icon={<EyeIcon className="size-3.5 shrink-0 text-text-dimmed" />}
      actions={
        <>
          <Button
            variant="primary/small"
            disabled={blocked}
            LeadingIcon={pending ? ButtonSpinner : undefined}
            onClick={onSubmit}
          >
            {pending ? "Starting…" : "Start watching"}
          </Button>
          <Button
            variant="minimal/small"
            disabled={pending}
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "Done" : "Customize"}
          </Button>
          {onCancel ? (
            <Button variant="minimal/small" disabled={pending} onClick={onCancel}>
              Cancel
            </Button>
          ) : null}
        </>
      }
    >
      {/* The compact card, always visible: what · the condition · the duration ·
          where the answer lands. Four lines, in that order, expanded or not. */}
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
          {/* The condition variant (§3). Only rendered where a second question
              exists — the kinds with none must not show an empty picker. */}
          {variant ? (
            <Field label="Tell me">
              <Choice
                selected
                onSelect={() => {
                  /* already the current condition */
                }}
              >
                {VARIANT_LABEL[spec.kind]}
              </Choice>
              <Choice selected={false} onSelect={() => onChange(withVariant(draft, variant))}>
                {VARIANT_LABEL[variant]}
              </Choice>
            </Field>
          ) : (
            <Field label="Tell me">
              <span className="text-xs text-text-dimmed">{watchConditionLabel(spec)}</span>
            </Field>
          )}

          {spec.kind === "queue_depth_above" ? (
            <Field label="Above">
              <Input
                type="number"
                min={0}
                variant="small"
                className="w-28"
                // A half-typed field must show empty, not "NaN" — it is a draft
                // in progress, and `watchDraftError` is what refuses to submit it.
                value={Number.isFinite(spec.threshold) ? String(spec.threshold) : ""}
                onChange={(event) =>
                  onChange(withThreshold(draft, Number.parseInt(event.target.value, 10)))
                }
                aria-label="Queue depth threshold"
              />
            </Field>
          ) : null}

          <Field label="For">
            {WATCH_WINDOW_HOURS_OPTIONS.map((hours) => (
              <Choice
                key={hours}
                selected={spec.maxHours === hours}
                onSelect={() => onChange(withWindow(draft, hours))}
              >
                {formatWatchWindow(hours)}
              </Choice>
            ))}
          </Field>

          {/* The cadence options come from the KIND's schema limits, so an
              aggregate watch can never be offered a 1-minute hot loop (§7.1). */}
          <Field label="Checking">
            {watchCadenceOptions(spec.kind).map((minutes) => (
              <Choice
                key={minutes}
                selected={spec.checkEveryMinutes === minutes}
                onSelect={() => onChange(withCadence(draft, minutes))}
              >
                {formatWatchCadence(minutes)}
              </Choice>
            ))}
          </Field>

          {/* Two INDEPENDENT opt-ins under a fixed delivery line — never a radio
              group, so "email instead of chat" is not expressible (§2.2). */}
          <Field label="When there's an answer">
            <div className="flex flex-col gap-1.5">
              <CheckboxWithLabel
                variant="simple/small"
                label="Investigate attention outcomes"
                defaultChecked={draft.followUp.investigateOnAttention}
                onChange={(checked) =>
                  onChange(withFollowUp(draft, { investigateOnAttention: checked }))
                }
              />
              <CheckboxWithLabel
                variant="simple/small"
                label="Also notify me externally"
                defaultChecked={draft.followUp.notifyExternally}
                onChange={(checked) => onChange(withFollowUp(draft, { notifyExternally: checked }))}
              />
            </div>
          </Field>
        </div>
      ) : null}

      {/* Errors live and die with the card: nothing is persisted, and the user
          fixes the draft in place rather than starting again (§2.2 step 5). */}
      {localError || error ? (
        <p className="pt-1 text-xs text-error">{localError ?? error}</p>
      ) : null}
    </ChatSystemBlock>
  );
}
