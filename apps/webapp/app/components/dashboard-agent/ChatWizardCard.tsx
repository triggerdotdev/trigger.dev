import {
  ArrowRightIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  InformationCircleIcon,
  XMarkIcon,
} from "@heroicons/react/20/solid";
import { CheckMarkIcon } from "~/assets/icons/CheckMarkIcon";
import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { AlertChannelsDialog } from "~/components/alerts/AlertChannelsDialog";
import { expiryError } from "~/components/dashboard-agent/alert-creation/flow-state";
import { Button } from "~/components/primitives/Buttons";
import { DateField } from "~/components/primitives/DateField";
import { FormError } from "~/components/primitives/FormError";
import { Icon, type RenderIcon } from "~/components/primitives/Icon";
import { Input } from "~/components/primitives/Input";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Select, SelectItem } from "~/components/primitives/Select";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { cn } from "~/utils/cn";

export type ChatWizardOption = {
  id: string;
  label: string;
  cardLabel?: string;
  icon?: RenderIcon;
  trailingIcon?: RenderIcon | null;
  expanded?: boolean;
  disabledReason?: string;
  description?: string;
};

export function StepDescription({ step }: { step: ChatWizardStep }) {
  const [open, setOpen] = useState(false);
  const text = step.description ?? "";
  const label = step.descriptionAction?.label;
  const at = label ? text.indexOf(label) : -1;
  if (!label || at < 0) return text;
  return (
    <>
      {text.slice(0, at)}
      <button
        type="button"
        className="text-text-link underline decoration-text-link/40 underline-offset-2 hover:decoration-text-link"
        onClick={() => setOpen(true)}
      >
        {label}
      </button>
      {text.slice(at + label.length)}
      {open ? <AlertChannelsDialog open onClose={() => setOpen(false)} /> : null}
    </>
  );
}

export type ChatWizardInput = {
  id: string;
  label?: string;
  placeholder?: string;
  ariaLabel: string;
  numeric?: boolean;
  type?: "date";
  unit?: string;
  rule?: { min?: number; max?: number; allowZero?: boolean };
  parse: (text: string) => string | undefined;
  onSubmit: (value: string) => void;
  onClear?: () => void;
  current?: string;
  live?: boolean;
};

export type ChatWizardStep = {
  id: string;
  question: string;
  description?: string;
  descriptionAction?: { label: string };
  options: ChatWizardOption[];
  allowSkip?: boolean;
  multiSelect?: boolean;
  selected?: string[];
  custom?: ChatWizardInput & { open?: boolean };
  customOption?: string;
  onReveal?: () => void;
  selectedDescription?: string;
  lead?: string;
  confirmDisabled?: boolean;
  confirmLabel?: string;
  entity?: ChatWizardEntity;
  entityOption?: string;
  fields?: ChatWizardInput[];
  error?: string;
  hint?: string;
  placeholder?: string;
  selectDisabled?: boolean;
};

type ChatWizardEntity = {
  id: string;
  ariaLabel: string;
  placeholder: string;
  options: ChatWizardOption[];
  selected?: string;
  onSelect: (id: string) => void;
  onPick?: () => void;
  onSearch?: (text: string) => void;
  custom?: ChatWizardInput;
};

export type ChatWizardCardProps = {
  steps: ChatWizardStep[];
  stepIndex: number;
  onStepChange: (stepIndex: number) => void;
  onSelect: (stepId: string, optionId: string) => void;
  onSkip: (stepId: string) => void;
  onClose: () => void;
  onConfirm?: (stepId: string) => void;
  className?: string;
  maxHeight?: number;
};

const ROW =
  "flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm tabular-nums transition focus-custom";
const TOOLTIP_DELAY_MS = 500;
const TOOLTIP_WIDTH = "max-w-[300px]";
const ICON_BUTTON = "aspect-square min-w-0 px-1";
const INPUT_RESET =
  "border-0 outline-0 focus:shadow-none focus:ring-0 focus-visible:ring-0 focus-visible:outline-none";
const CARD_INPUT_WIDTH = "max-w-full";
const CUSTOM_ROW = "__custom__";
const BARE_INPUT = `min-w-0 bg-transparent p-0 text-sm tabular-nums text-text-bright placeholder:text-text-dimmed ${INPUT_RESET} ${CARD_INPUT_WIDTH} [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none [-moz-appearance:textfield]`;

function parseInput(input: ChatWizardInput, text: string): string | undefined {
  const value = input.parse(text);
  if (value === undefined || !input.numeric || input.rule?.min !== 0 || input.rule.allowZero)
    return value;
  return Number(value) > 0 ? value : undefined;
}

function inputError(input: ChatWizardInput, text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "Enter a value";
  if (!input.numeric) return "Enter a valid value";
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return "Enter a number";
  const { min, max, allowZero } = input.rule ?? {};
  if (min === 0 && !allowZero && n <= 0) return "Must be greater than 0";
  if (min !== undefined && max !== undefined) return `Must be between ${min} and ${max}`;
  if (min !== undefined) return `Must be at least ${min}`;
  if (max !== undefined) return `Must be at most ${max}`;
  return "Enter a number";
}

function dateError(date: Date | undefined, value: string | undefined): string | undefined {
  if (!date || value !== undefined) return undefined;
  return Number.isNaN(date.getTime()) ? "Enter a valid date" : expiryError(date);
}

type InputRowProps = {
  input: ChatWizardInput;
  autoFocus?: boolean;
  onValidity: (valid: boolean) => void;
  className?: string;
  stacked?: boolean;
  fieldClassName?: string;
};

export function InputRow(props: InputRowProps) {
  return props.input.type === "date" ? <DateRow {...props} /> : <TextRow {...props} />;
}

function DateRow({ input, className, onValidity, fieldClassName }: InputRowProps) {
  const [now] = useState(() => new Date());
  const [initial] = useState(() => (input.current ? new Date(input.current) : undefined));
  const [date, setDate] = useState(initial);
  const [error, setError] = useState<string>();
  const commit = (next: Date | undefined, final = true) => {
    if (!next) return;
    const value = expiryError(next) ? undefined : input.parse(next.toISOString());
    setError(dateError(next, value));
    if (value !== undefined) input.onSubmit(value);
    else if (final && input.current !== undefined) input.onClear?.();
  };

  useEffect(() => {
    onValidity(!error);
  }, [error]); // eslint-disable-line react-hooks/exhaustive-deps -- report on change only
  useEffect(() => () => onValidity(true), []); // eslint-disable-line react-hooks/exhaustive-deps -- clear once on unmount

  return (
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- catches Enter and blur from the date segments inside
    <li
      className={cn("flex flex-col gap-1 px-3 py-2", className)}
      onKeyDownCapture={(e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        commit(date);
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) commit(date);
      }}
    >
      <DateField
        label={input.ariaLabel}
        defaultValue={initial}
        minValue={now}
        granularity="minute"
        variant="small"
        fieldClassName={cn("min-w-0", fieldClassName)}
        invalid={Boolean(error)}
        dayFirst
        hourCycle={24}
        onValueChange={(next) => {
          setDate(next);
          commit(next, false);
        }}
      />
      <FormError>{error}</FormError>
    </li>
  );
}

const CUSTOM_ENTITY = "__custom__";

function TextRow({
  input,
  autoFocus,
  onValidity,
  className,
  stacked,
  fieldClassName,
}: InputRowProps) {
  const [text, setText] = useState(input.current ?? "");
  const [touched, setTouched] = useState(false);
  const value = parseInput(input, text);
  const invalid = text.trim() !== "" && value === undefined;
  const error = (touched || invalid) && value === undefined ? inputError(input, text) : undefined;

  useEffect(() => {
    onValidity(!invalid);
  }, [invalid]); // eslint-disable-line react-hooks/exhaustive-deps -- report on change only
  useEffect(() => () => onValidity(true), []); // eslint-disable-line react-hooks/exhaustive-deps -- clear once on unmount

  return (
    <li className={cn("flex flex-col gap-1 px-3 py-2", className)}>
      <div className={stacked ? "flex flex-col gap-1" : "flex items-center gap-2"}>
        {input.label ? (
          <span className="shrink-0 text-xs text-text-dimmed">{input.label}</span>
        ) : null}
        <Input
          variant="small"
          containerClassName={cn("min-w-0 flex-1", error && "border-error", fieldClassName)}
          className={cn("tabular-nums", INPUT_RESET)}
          type={input.numeric ? "number" : "text"}
          inputMode={input.numeric ? "decimal" : undefined}
          value={text}
          placeholder={input.placeholder}
          aria-label={input.ariaLabel}
          aria-invalid={Boolean(error)}
          autoFocus={autoFocus}
          onChange={(e) => {
            setText(e.target.value);
            if (!e.target.value.trim()) setTouched(false);
            const parsed = parseInput(input, e.target.value);
            if (!input.live) return;
            if (parsed !== undefined) input.onSubmit(parsed);
          }}
          onBlur={() => {
            if (value === undefined && input.current !== undefined) input.onClear?.();
            if (value !== undefined && !input.live && value !== input.current)
              input.onSubmit(value);
          }}
          onKeyDown={(e) => {
            if (input.numeric && /^[a-z]$/i.test(e.key) && !e.metaKey && !e.ctrlKey) {
              e.preventDefault();
              return;
            }
            if (e.key !== "Enter") return;
            e.preventDefault();
            setTouched(true);
            if (value !== undefined && !input.live) input.onSubmit(value);
          }}
        />
      </div>
      <FormError>{error}</FormError>
    </li>
  );
}

type WizardInputRowProps = {
  value: string;
  unit?: string;
  valid: boolean;
  selected?: boolean;
  onConfirm?: () => void;
  onRestore?: () => void;
  label?: string;
  error?: string;
  children: ReactNode;
};

function WizardInputRow({
  value,
  unit,
  valid,
  selected,
  onConfirm,
  onRestore,
  label,
  error,
  children,
}: WizardInputRowProps) {
  return (
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Enter and Esc from the control inside
    <li
      data-wizard-row=""
      className={cn(ROW, "flex-col items-stretch gap-1 text-text-bright")}
      onKeyDownCapture={(e) => {
        if (e.key !== "Enter" || !e.currentTarget.contains(e.target as Node)) return;
        if (valid && onConfirm) {
          e.preventDefault();
          e.stopPropagation();
          onConfirm();
        } else if (!(e.target instanceof HTMLButtonElement)) e.preventDefault();
      }}
      onKeyDown={(e) => {
        if (e.key !== "Escape" || !e.currentTarget.contains(e.target as Node)) return;
        e.preventDefault();
        e.stopPropagation();
        e.currentTarget.closest<HTMLElement>("[role=dialog]")?.focus();
        onRestore?.();
      }}
    >
      <div className="flex items-center gap-2.5">
        {label ? <span className="w-[200px] shrink-0 text-text-dimmed">{label}</span> : null}
        <div className={cn("flex min-w-0 flex-1 items-center gap-1", label && "max-w-[200px]")}>
          {children}
          {unit ? <span className="shrink-0 text-text-dimmed">{unit}</span> : null}
        </div>
        {selected ? (
          <CheckMarkIcon aria-label="Selected" className="size-4 shrink-0 text-success" />
        ) : null}
        {onConfirm ? (
          <button
            type="button"
            aria-label="Confirm"
            disabled={!valid}
            onClick={onConfirm}
            className={cn(
              "shrink-0 rounded-sm text-text-dimmed transition focus-custom hover:text-text-bright",
              !valid && "invisible"
            )}
          >
            <ArrowRightIcon className="size-4" />
          </button>
        ) : null}
      </div>
      <FormError>{error}</FormError>
    </li>
  );
}

type CardInputProps = {
  input: ChatWizardInput;
  label?: string;
  autoFocus?: boolean;
  onValidity: (valid: boolean) => void;
  onRestore: () => void;
  onAdvance?: () => void;
};

function CardInput(props: CardInputProps) {
  return props.input.type === "date" ? <CardDate {...props} /> : <CardText {...props} />;
}

function CardText({ input, label, autoFocus, onValidity, onRestore, onAdvance }: CardInputProps) {
  const [text, setText] = useState(input.current ?? "");
  const [touched, setTouched] = useState(false);
  const value = parseInput(input, text);
  const invalid = text.trim() !== "" && value === undefined;
  const error = (touched || invalid) && value === undefined ? inputError(input, text) : undefined;

  useEffect(() => {
    onValidity(!invalid);
  }, [invalid]); // eslint-disable-line react-hooks/exhaustive-deps -- report on change only
  useEffect(() => () => onValidity(true), []); // eslint-disable-line react-hooks/exhaustive-deps -- clear once on unmount

  const confirm = () => {
    if (value === undefined) return;
    if (value === input.current && onAdvance) onAdvance();
    else input.onSubmit(value);
  };

  return (
    <WizardInputRow
      value={text.trim()}
      unit={input.unit}
      valid={value !== undefined}
      selected={!input.live && value !== undefined && value === input.current}
      onConfirm={input.live ? undefined : confirm}
      onRestore={onRestore}
      label={label}
      error={error}
    >
      <input
        className={BARE_INPUT}
        style={{ width: `${Math.max(text.length, input.placeholder?.length ?? 0, 2)}ch` }}
        type={input.numeric ? "number" : "text"}
        inputMode={input.numeric ? "decimal" : undefined}
        value={text}
        placeholder={input.placeholder}
        aria-label={input.ariaLabel}
        aria-invalid={Boolean(error)}
        autoFocus={autoFocus}
        onBlur={() => {
          if (value === undefined && input.current !== undefined) input.onClear?.();
        }}
        onChange={(e) => {
          setText(e.target.value);
          if (!e.target.value.trim()) setTouched(false);
          const parsed = parseInput(input, e.target.value);
          if (!input.live) return;
          if (parsed !== undefined) input.onSubmit(parsed);
        }}
        onKeyDown={(e) => {
          if (input.numeric && /^[a-z]$/i.test(e.key) && !e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            return;
          }
          if (e.key !== "Enter") return;
          e.preventDefault();
          setTouched(true);
        }}
      />
    </WizardInputRow>
  );
}

function CardDate({ input, autoFocus, onValidity, onRestore, onAdvance }: CardInputProps) {
  const [now] = useState(() => new Date());
  const [initial] = useState(() => (input.current ? new Date(input.current) : undefined));
  const [date, setDate] = useState(initial);
  const [rejected, setRejected] = useState(false);
  const value =
    !rejected && date && !Number.isNaN(date.getTime()) && !expiryError(date)
      ? input.parse(date.toISOString())
      : undefined;
  const error = rejected ? "Enter a valid date" : dateError(date, value);
  const unchanged = Boolean(date && initial && date.getTime() === initial.getTime());

  useEffect(() => {
    onValidity(!error);
  }, [error]); // eslint-disable-line react-hooks/exhaustive-deps -- report on change only
  useEffect(() => () => onValidity(true), []); // eslint-disable-line react-hooks/exhaustive-deps -- clear once on unmount

  return (
    <WizardInputRow
      value=""
      valid={value !== undefined}
      selected={value !== undefined && unchanged}
      onConfirm={() => {
        if (value === undefined) return;
        if (unchanged && onAdvance) onAdvance();
        else input.onSubmit(value);
      }}
      onRestore={onRestore}
      error={error}
    >
      <DateField
        label={input.ariaLabel}
        defaultValue={initial}
        minValue={now}
        granularity="minute"
        variant="small"
        borderless
        autoFocus={autoFocus}
        invalid={Boolean(error)}
        dayFirst
        hourCycle={24}
        onInvalidInput={() => setRejected(true)}
        onValueChange={(next) => {
          setRejected(false);
          setDate(next);
        }}
      />
    </WizardInputRow>
  );
}

function CardEntity({ entity, onAdvance }: { entity: ChatWizardEntity; onAdvance?: () => void }) {
  const items = entity.custom
    ? [{ id: CUSTOM_ENTITY, label: "Custom" }, ...entity.options]
    : entity.options;
  const [draft, setDraft] = useState(entity.custom ? CUSTOM_ENTITY : (entity.selected ?? ""));
  const valid = Boolean(draft) && draft !== CUSTOM_ENTITY;
  return (
    <WizardInputRow
      value={draft}
      valid={valid}
      selected={Boolean(draft)}
      onConfirm={() => {
        if (!valid) return;
        if (draft === entity.selected && onAdvance) onAdvance();
        else entity.onSelect(draft);
      }}
    >
      <Select
        aria-label={entity.ariaLabel}
        variant="minimal/small"
        dropdownIcon={
          <ChevronDownIcon className="size-4 flex-none text-text-dimmed opacity-0 group-hover:opacity-100 group-aria-expanded:opacity-100" />
        }
        className="h-auto w-full px-0 text-sm hover:bg-transparent"
        portal
        popoverClassName="min-w-27 h-[min(280px,var(--popover-available-height))]"
        heading="Search…"
        filter={entity.onSearch ? () => true : { keys: ["label"] }}
        onSearchChange={entity.onSearch}
        empty={
          entity.onSearch ? <div className="p-2 text-xs text-text-dimmed">No matches</div> : null
        }
        disabled={items.length === 0 && !entity.onSearch}
        value={draft}
        setValue={(next: string) => {
          if (!next || next === CUSTOM_ENTITY) return;
          setDraft(next);
          entity.onPick?.();
        }}
        text={(current: string) =>
          items.find((item) => item.id === current)?.label ?? (current || undefined)
        }
        placeholder={entity.placeholder}
        items={items}
      >
        {(list) =>
          list.map((item) => (
            <SelectItem key={item.id} value={item.id} className="text-text-bright">
              {item.label}
            </SelectItem>
          ))
        }
      </Select>
    </WizardInputRow>
  );
}

function OptionInfo({
  label,
  description,
  picked,
}: {
  label: string;
  description: string;
  picked?: boolean;
}) {
  return (
    <span
      className={cn(
        "absolute top-1/2 z-10 flex -translate-y-1/2",
        picked ? "right-16" : "right-[2.375rem]"
      )}
    >
      <SimpleTooltip
        asChild
        tabbable
        disableHoverableContent
        delayDuration={TOOLTIP_DELAY_MS}
        className={TOOLTIP_WIDTH}
        button={
          <button
            type="button"
            aria-label={`About ${label}`}
            className="rounded-sm text-text-dimmed opacity-0 transition focus-custom hover:text-text-bright focus-visible:opacity-100 group-hover:opacity-100 data-[state=delayed-open]:opacity-100"
          >
            <InformationCircleIcon className="size-4" />
          </button>
        }
        content={description}
      />
    </span>
  );
}

function useBottomFade(list: RefObject<HTMLElement>) {
  const [fade, setFade] = useState(false);
  const update = () => {
    const el = list.current;
    setFade(Boolean(el) && el!.scrollHeight - el!.scrollTop - el!.clientHeight > 1);
  };
  useEffect(() => {
    const el = list.current;
    if (!el) return;
    const resize = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(update);
    resize?.observe(el);
    const mutation = new MutationObserver(update);
    mutation.observe(el, { childList: true, subtree: true });
    return () => {
      resize?.disconnect();
      mutation.disconnect();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- observe once
  return { fade, onScroll: update };
}

function inOtherDialog(target: EventTarget | null, card: HTMLElement | null) {
  if (!(target instanceof Element)) return false;
  const dialog = target.closest("[role=dialog]");
  return Boolean(dialog && dialog !== card);
}

function isEditable(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}

function withoutEntityOption(step: ChatWizardStep | undefined) {
  return step?.entityOption
    ? { ...step, options: step.options.filter((option) => option.id !== step.entityOption) }
    : step;
}

export function ChatWizardCard({
  steps,
  stepIndex,
  onStepChange,
  onSelect,
  onSkip,
  onClose,
  onConfirm,
  className,
  maxHeight,
}: ChatWizardCardProps) {
  const step = withoutEntityOption(steps[stepIndex]);
  const customId = step?.custom ? (step.customOption ?? CUSTOM_ROW) : undefined;
  const rows: ChatWizardOption[] =
    step?.custom && !step.customOption
      ? [...step.options, { id: CUSTOM_ROW, label: "Custom" }]
      : (step?.options ?? []);
  const [revealed, setRevealed] = useState<string>();
  const [resets, setResets] = useState(0);
  const [active, setActive] = useState({ stepId: step?.id, index: 0 });
  const activeIndex = active.stepId === step?.id ? active.index : 0;
  const setActiveIndex = (index: number) => setActive({ stepId: step?.id, index });
  const hasPrev = stepIndex > 0;
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const scroll = useBottomFade(listRef);
  const [invalidInputs, setInvalidInputs] = useState<Record<string, boolean>>({});
  const blocked = Object.entries(invalidInputs).some(
    ([key, bad]) => bad && key.startsWith(`${step?.id}:`)
  );
  const hasNext =
    stepIndex < steps.length - 1 &&
    Boolean(step?.selected?.length) &&
    !blocked &&
    (!step?.entity ||
      (step.entityOption !== undefined && !step.selected?.includes(step.entityOption)) ||
      Boolean(step.entity.selected));
  const reportValidity = (key: string) => (valid: boolean) =>
    setInvalidInputs((prev) => (prev[key] === !valid ? prev : { ...prev, [key]: !valid }));

  const keyOrigin = (e: KeyboardEvent) => {
    const target = e.target instanceof Node ? e.target : null;
    const el = target instanceof Element ? target : null;
    return {
      target,
      el,
      inCard: Boolean(rootRef.current?.contains(target)),
      inComposer: Boolean(el?.closest("[data-agent-composer]")),
      inPanel: target === document.body || Boolean(el?.closest("[data-agent-panel]")),
    };
  };

  const onEscape = (e: KeyboardEvent) => {
    if (!step || e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
    if (inOtherDialog(e.target, rootRef.current)) return;
    const { target, el, inCard, inComposer, inPanel } = keyOrigin(e);
    if (!inCard && !inComposer && (!inPanel || isEditable(target))) return;
    if (inCard && el?.closest("[data-wizard-row]")) return;
    e.preventDefault();
    e.stopPropagation();
    if (inCard && isEditable(target)) {
      rootRef.current?.focus();
      return;
    }
    onClose();
  };

  const choose = (stepId: string, optionId: string) => {
    if (optionId !== customId || step?.selected?.includes(optionId)) {
      setRevealed(undefined);
      return onSelect(stepId, optionId);
    }
    step?.onReveal?.();
    setRevealed(stepId);
  };

  const pick = (option: ChatWizardOption | undefined) => {
    if (!step || !option || option.disabledReason || blocked) return false;
    choose(step.id, option.id);
    return true;
  };

  const fieldCount = step?.fields?.length ?? 0;
  const moveTo = (index: number) => {
    setActiveIndex(index);
    listRef.current?.children[index + fieldCount]?.scrollIntoView?.({ block: "nearest" });
  };
  const advance = hasNext ? () => onStepChange(stepIndex + 1) : undefined;
  const restore = () => {
    setRevealed(undefined);
    setResets((n) => n + 1);
  };
  const customOpen = Boolean(
    step?.custom &&
    (step.custom.open ||
      revealed === step.id ||
      (customId !== undefined && step.selected?.includes(customId)) ||
      (!step.customOption &&
        step.custom.current &&
        !step.options.some((option) => step.selected?.includes(option.id))))
  );
  const customRow = (input: ChatWizardInput) => (
    <CardInput
      key={`${step?.id}:${input.id}:${resets}`}
      input={{ ...input, placeholder: undefined }}
      autoFocus
      onValidity={reportValidity(`${step?.id}:${input.id}`)}
      onRestore={restore}
      onAdvance={advance}
    />
  );

  const onKeyDown = (e: KeyboardEvent) => {
    if (!step || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    if (isEditable(e.target) || inOtherDialog(e.target, rootRef.current)) return;
    const { inCard, inComposer, inPanel } = keyOrigin(e);
    if (!inCard && !inComposer && !inPanel) return;
    if (/^[1-9]$/.test(e.key)) {
      if (pick(rows[Number(e.key) - 1])) e.preventDefault();
      return;
    }
    switch (e.key) {
      case "ArrowLeft":
        if (!hasPrev) return;
        e.preventDefault();
        onStepChange(stepIndex - 1);
        return;
      case "ArrowRight":
        if (!hasNext) return;
        e.preventDefault();
        onStepChange(stepIndex + 1);
        return;
      case "ArrowDown":
        e.preventDefault();
        moveTo(Math.min(activeIndex + 1, rows.length - 1));
        return;
      case "ArrowUp":
        e.preventDefault();
        moveTo(Math.max(activeIndex - 1, 0));
        return;
      case "Enter": {
        if (e.target instanceof HTMLButtonElement) return;
        if (pick(rows[activeIndex])) e.preventDefault();
        return;
      }
    }
  };

  const keyHandler = useRef({ onKeyDown, onEscape });
  useEffect(() => {
    keyHandler.current = { onKeyDown, onEscape };
  });

  // Capture phase: the agent panel's own Esc handler would otherwise close the panel first.
  useEffect(() => {
    const listener = (e: KeyboardEvent) => keyHandler.current.onKeyDown(e);
    const escape = (e: KeyboardEvent) => keyHandler.current.onEscape(e);
    document.addEventListener("keydown", listener);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("keydown", listener);
      document.removeEventListener("keydown", escape, true);
    };
  }, []);

  if (!step) return null;

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      style={maxHeight ? { maxHeight } : undefined}
      role="dialog"
      aria-label={step.question}
      className={cn(
        "flex flex-col overflow-hidden rounded-lg border outline-none border-grid-bright bg-background-dimmed shadow-lg",
        className
      )}
    >
      <div className="flex shrink-0 flex-wrap items-start gap-x-3 px-3 pb-2 pt-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5 pl-0.5 pt-0.5">
          <Paragraph variant="small/bright">{step.question}</Paragraph>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {steps.length > 1 ? (
            <>
              <Button
                variant="minimal/small"
                className={ICON_BUTTON}
                aria-label="Previous question"
                disabled={!hasPrev}
                onClick={() => onStepChange(stepIndex - 1)}
                LeadingIcon={ChevronLeftIcon}
              />
              <span className="text-xs tabular-nums text-text-dimmed">
                {stepIndex + 1} of {steps.length}
              </span>
              <Button
                variant="minimal/small"
                className={ICON_BUTTON}
                aria-label="Next question"
                disabled={!hasNext}
                onClick={() => onStepChange(stepIndex + 1)}
                LeadingIcon={ChevronRightIcon}
              />
            </>
          ) : null}
          <Button
            variant="minimal/small"
            className={ICON_BUTTON}
            aria-label="Close"
            onClick={onClose}
            LeadingIcon={XMarkIcon}
          />
        </div>
        {step.description ? (
          <p className="w-full pl-0.5 pt-0.5 text-xs tabular-nums text-text-dimmed">
            <StepDescription step={step} />
          </p>
        ) : null}
      </div>
      <div className="relative flex min-h-0 flex-col">
        <ul
          ref={listRef}
          onScroll={scroll.onScroll}
          className="min-h-0 divide-y divide-grid-bright overflow-y-auto overflow-x-hidden border-t border-grid-bright scrollbar-thin"
        >
          {step.fields?.map((field, index) => (
            <CardInput
              key={`${step.id}:${field.id}:${resets}`}
              input={field}
              autoFocus={index === 0}
              label={field.label}
              onValidity={reportValidity(`${step.id}:${field.id}`)}
              onRestore={restore}
            />
          ))}
          {rows.map((option, index) => {
            if (step.custom && customOpen && option.id === customId) {
              return customRow(step.custom);
            }
            const active = index === activeIndex;
            const picked = step.selected?.includes(option.id);
            const info = option.disabledReason ? undefined : option.description;
            const row = (
              <button
                type="button"
                disabled={Boolean(option.disabledReason) || blocked}
                aria-pressed={
                  step.multiSelect && option.expanded === undefined ? Boolean(picked) : undefined
                }
                aria-expanded={option.expanded}
                onClick={() => {
                  rootRef.current?.focus();
                  choose(step.id, option.id);
                }}
                onMouseEnter={() => setActiveIndex(index)}
                onFocus={() => setActiveIndex(index)}
                className={cn(
                  ROW,
                  "text-text-bright disabled:cursor-not-allowed disabled:opacity-50",
                  active ? "bg-background-hover" : "group-hover:bg-background-hover"
                )}
              >
                {option.icon ? (
                  <Icon icon={option.icon} className="size-4 shrink-0 text-text-dimmed" />
                ) : null}
                <span className="min-w-0 flex-1">{option.cardLabel ?? option.label}</span>
                {info ? <span aria-hidden className="size-4 shrink-0" /> : null}
                {picked ? (
                  <CheckMarkIcon aria-label="Selected" className="size-4 shrink-0 text-success" />
                ) : null}
                {option.expanded !== undefined ? (
                  <ChevronDownIcon
                    data-expander
                    className={cn(
                      "size-4 shrink-0 text-text-dimmed",
                      !active && !option.expanded && "invisible"
                    )}
                  />
                ) : option.trailingIcon === null || step.multiSelect ? null : (
                  <Icon
                    icon={option.trailingIcon ?? ArrowRightIcon}
                    className={cn("size-4 shrink-0 text-text-dimmed", !active && "invisible")}
                  />
                )}
              </button>
            );
            return (
              <li key={option.id} className="group relative">
                {info ? (
                  <OptionInfo label={option.label} description={info} picked={picked} />
                ) : null}
                {option.disabledReason ? (
                  <SimpleTooltip
                    asChild
                    disableHoverableContent
                    delayDuration={TOOLTIP_DELAY_MS}
                    className={TOOLTIP_WIDTH}
                    button={<span className="block">{row}</span>}
                    content={option.disabledReason}
                  />
                ) : (
                  row
                )}
              </li>
            );
          })}
          {step.entity ? (
            <>
              <CardEntity
                key={`${step.id}:${step.entity.id}:${step.entity.custom ? "custom" : "list"}:${step.entity.selected ?? ""}:${resets}`}
                entity={step.entity}
                onAdvance={advance}
              />
              {step.entity.custom ? customRow(step.entity.custom) : null}
            </>
          ) : null}
        </ul>
        {scroll.fade ? (
          <div
            aria-hidden
            data-testid="scroll-fade"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-linear-to-t from-background-dimmed to-transparent"
          />
        ) : null}
      </div>
      <ul className="shrink-0 divide-y divide-grid-bright border-t border-grid-bright empty:hidden">
        {step.allowSkip !== false ? (
          <li className="flex justify-end px-3 py-2">
            <Button variant="secondary/small" onClick={() => onSkip(step.id)}>
              Skip
            </Button>
          </li>
        ) : null}
        {step.hint ? <li className="px-3 py-2 text-xs text-text-dimmed">{step.hint}</li> : null}
        {step.error ? (
          <li role="alert" className="px-3 py-2 text-xxs text-error">
            {step.error}
          </li>
        ) : null}
        {step.multiSelect ? (
          <li className="flex justify-end px-3 py-2">
            <Button
              variant="primary/small"
              disabled={!step.selected?.length || blocked || step.confirmDisabled}
              onClick={() => onConfirm?.(step.id)}
            >
              {step.confirmLabel ?? "Done"}
            </Button>
          </li>
        ) : null}
      </ul>
    </div>
  );
}
