import { AdjustmentsHorizontalIcon, PauseIcon, PlayIcon } from "@heroicons/react/20/solid";
import { DialogClose } from "@radix-ui/react-dialog";
import { Form, useNavigation } from "@remix-run/react";
import { useEffect, useState } from "react";
import { cn } from "~/utils/cn";
import type { QueueLimits } from "~/components/queues/queue-limits";
import { Button, type ButtonVariant } from "~/components/primitives/Buttons";
import { Dialog, DialogContent, DialogHeader, DialogTrigger } from "~/components/primitives/Dialog";
import { FormButtons } from "~/components/primitives/FormButtons";
import { FormError } from "~/components/primitives/FormError";
import { Hint } from "~/components/primitives/Hint";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { Paragraph } from "~/components/primitives/Paragraph";
import { PopoverMenuItem } from "~/components/primitives/Popover";
import SegmentedControl from "~/components/primitives/SegmentedControl";
import { Spinner } from "~/components/primitives/Spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "~/components/primitives/Tooltip";

// Per-queue action controls. Extracted from the Queues list route so the queue detail page can
// reuse them. Both submit a `<Form method="post">` to the current route, so whichever route renders
// them must handle the `queue-pause` / `queue-resume` / `queue-override` / `queue-remove-override`
// actions (see `handleQueueMutationAction` in `~/models/queueMutation.server`).

export function QueuePauseResumeButton({
  queue,
  variant = "tertiary/small",
  fullWidth = false,
  showTooltip = true,
  iconOnly = false,
  withQueueName = false,
  disabled = false,
  noun = "queue",
}: {
  /** The "id" here is a friendlyId */
  queue: { id: string; name: string; paused: boolean };
  variant?: ButtonVariant;
  fullWidth?: boolean;
  showTooltip?: boolean;
  /** Icon-only trigger (label moves to the tooltip). For compact placements like the detail-page
   * live blocks. */
  iconOnly?: boolean;
  /** Render the full "Pause/Resume {name} queue" label instead of the short "Pause"/"Resume". */
  withQueueName?: boolean;
  disabled?: boolean;
  /** What the row is called in every user-facing string: named concurrency limits pause through
   * the same actions but their dialogs must say "limit". */
  noun?: "queue" | "limit";
}) {
  const [isOpen, setIsOpen] = useState(false);

  const label = queue.paused
    ? noun === "limit"
      ? `Resumes the "${queue.name}" limit so runs holding it can be dequeued again.`
      : `Resumes the "${queue.name}" queue so its runs can be dequeued again.`
    : noun === "limit"
      ? `Pauses all runs holding the "${queue.name}" limit from being dequeued. Any executing runs will continue to run.`
      : `Pauses all runs from being dequeued in the "${queue.name}" queue. Any executing runs will continue to run.`;

  const tooltip = disabled ? `You don't have permission to manage ${noun}s` : label;

  const trigger = showTooltip ? (
    <div>
      <TooltipProvider disableHoverableContent={true}>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className={iconOnly ? "cursor-pointer [&_button]:cursor-pointer" : undefined}>
              <DialogTrigger asChild>
                <Button
                  type="button"
                  variant={variant}
                  className={cn(
                    iconOnly &&
                      (queue.paused
                        ? "system:border-transparent system:bg-success system:transition system:group-hover/button:bg-success system:group-hover/button:brightness-90"
                        : "system:border-transparent system:bg-warning system:transition system:group-hover/button:bg-warning system:group-hover/button:brightness-90"),
                    withQueueName &&
                      (queue.paused
                        ? "border-success/60 text-success [&_span]:text-success hover:border-success"
                        : "border-warning/60 text-warning [&_span]:text-warning hover:border-warning")
                  )}
                  LeadingIcon={queue.paused ? PlayIcon : PauseIcon}
                  leadingIconClassName={cn(
                    queue.paused ? "text-success" : "text-warning",
                    iconOnly && "system:text-white"
                  )}
                  fullWidth={fullWidth}
                  textAlignLeft={fullWidth}
                  aria-label={label}
                  disabled={disabled}
                >
                  {iconOnly
                    ? undefined
                    : withQueueName
                      ? queue.paused
                        ? `Resume this ${noun}…`
                        : `Pause this ${noun}…`
                      : queue.paused
                        ? "Resume"
                        : "Pause"}
                </Button>
              </DialogTrigger>
            </div>
          </TooltipTrigger>
          <TooltipContent side="right" className={"text-xs"}>
            {tooltip}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  ) : (
    <DialogTrigger asChild>
      <PopoverMenuItem
        icon={queue.paused ? PlayIcon : PauseIcon}
        leadingIconClassName={queue.paused ? "text-success" : "text-warning"}
        title={
          disabled
            ? `You don't have permission to manage ${noun}s`
            : queue.paused
              ? "Resume..."
              : "Pause..."
        }
        disabled={disabled}
      />
    </DialogTrigger>
  );

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      {trigger}
      <DialogContent>
        <DialogHeader>{queue.paused ? `Resume ${noun}?` : `Pause ${noun}?`}</DialogHeader>
        <div className="flex flex-col gap-3 pt-3">
          <Paragraph>
            {queue.paused
              ? noun === "limit"
                ? `This will allow runs holding the "${queue.name}" limit to be dequeued again.`
                : `This will allow runs to be dequeued in the "${queue.name}" queue again.`
              : noun === "limit"
                ? `This will pause all runs holding the "${queue.name}" limit from being dequeued. Any executing runs will continue to run.`
                : `This will pause all runs from being dequeued in the "${queue.name}" queue. Any executing runs will continue to run.`}
          </Paragraph>
          <Form method="post" onSubmit={() => setIsOpen(false)}>
            <input
              type="hidden"
              name="action"
              value={queue.paused ? "queue-resume" : "queue-pause"}
            />
            <input type="hidden" name="friendlyId" value={queue.id} />
            <input type="hidden" name="noun" value={noun} />
            <FormButtons
              confirmButton={
                <Button
                  type="submit"
                  shortcut={{ modifiers: ["mod"], key: "enter" }}
                  variant={queue.paused ? "primary/medium" : "danger/medium"}
                  LeadingIcon={queue.paused ? PlayIcon : PauseIcon}
                >
                  {queue.paused ? `Resume ${noun}` : `Pause ${noun}`}
                </Button>
              }
              cancelButton={
                <DialogClose asChild>
                  <Button type="button" variant="secondary/medium">
                    Cancel
                  </Button>
                </DialogClose>
              }
            />
          </Form>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function QueueOverrideConcurrencyButton({
  queue,
  environmentConcurrencyLimit,
  trigger,
  disabled = false,
  noun = "queue",
}: {
  queue: {
    id: string;
    name: string;
    limits: QueueLimits;
    concurrencyLimitOverridePercent: number | null;
  };
  environmentConcurrencyLimit: number;
  /** How to render the dialog trigger. "menu-item" (default) is a PopoverMenuItem for row menus;
   * "button" is a standalone labeled button; "icon" is an icon-only button with the label in a
   * hover tooltip, for compact placements like the detail-page live blocks. */
  trigger?: "menu-item" | "button" | "icon";
  disabled?: boolean;
  /** What the row is called in every user-facing string: named concurrency limits are overridden
   * through the same actions but their dialogs must say "limit". */
  noun?: "queue" | "limit";
}) {
  const navigation = useNavigation();
  const [isOpen, setIsOpen] = useState(false);
  const [mode, setMode] = useState<"absolute" | "percent">(
    queue.concurrencyLimitOverridePercent !== null ? "percent" : "absolute"
  );
  const [concurrencyLimit, setConcurrencyLimit] = useState<string>(
    queue.limits.perKey.current?.toString() ?? environmentConcurrencyLimit.toString()
  );
  const [percent, setPercent] = useState<string>(
    queue.concurrencyLimitOverridePercent?.toString() ?? "100"
  );

  /** A row with a total bound gets the two-field dialog: each bound is overridden on its own
   * and a blank field leaves that bound unchanged. Rows without a total keep the classic
   * single-limit dialog (with the percent toggle). */
  const hasTotal = queue.limits.total != null;
  /** Both fields start blank so blank-means-unchanged holds: a prefilled value would submit
   * as an explicit override of the current value, pinning it against future code changes.
   * The current values show as placeholders instead. */
  const [perKeyValue, setPerKeyValue] = useState<string>("");
  const [totalValue, setTotalValue] = useState<string>("");

  const isOverridden = hasTotal
    ? !!queue.limits.perKey.overriddenAt || !!queue.limits.total?.overriddenAt
    : !!queue.limits.perKey.overriddenAt;
  const currentLimit = queue.limits.perKey.current ?? environmentConcurrencyLimit;

  useEffect(() => {
    if (navigation.state === "loading" || navigation.state === "idle") {
      // oxlint-disable-next-line react/set-state-in-effect -- This effect intentionally synchronizes local state after an external or lifecycle change.
      setIsOpen(false);
    }
  }, [navigation.state]);

  const isLoading = Boolean(
    navigation.formData?.get("action") === "queue-override" ||
    navigation.formData?.get("action") === "queue-remove-override"
  );

  // Client-side mirror of the backend cap + materialization, so the user sees the resolved value
  // and can't submit an above-limit override.
  const percentNumber = Number(percent);
  const percentValid = Number.isFinite(percentNumber) && percentNumber > 0 && percentNumber <= 100;
  const materializedFromPercent = percentValid
    ? Math.min(
        Math.max(Math.floor((environmentConcurrencyLimit * percentNumber) / 100), 1),
        environmentConcurrencyLimit
      )
    : null;

  const limitNumber = Number(concurrencyLimit);
  const limitOverCap = Number.isFinite(limitNumber) && limitNumber > environmentConcurrencyLimit;

  const perKeyNumber = Number(perKeyValue);
  const perKeyOverCap =
    perKeyValue !== "" &&
    Number.isFinite(perKeyNumber) &&
    perKeyNumber > environmentConcurrencyLimit;
  const perKeyInvalid =
    perKeyValue !== "" && (!Number.isInteger(perKeyNumber) || perKeyNumber < 0 || perKeyOverCap);
  const totalNumber = Number(totalValue);
  const totalOverCap =
    totalValue !== "" && Number.isFinite(totalNumber) && totalNumber > environmentConcurrencyLimit;
  const totalInvalid =
    totalValue !== "" && (!Number.isInteger(totalNumber) || totalNumber < 1 || totalOverCap);

  /** Cross-field check on the pair that would be in effect after submit: a blank field keeps
   * its current value. A per-key limit above the total could never be reached, so creating
   * that state is blocked. The API treats the bounds independently, so a pair that already
   * conflicts stays editable: improvements submit with a notice instead of being trapped. */
  const resultingPerKey = perKeyValue !== "" ? perKeyNumber : queue.limits.perKey.current;
  const resultingTotal = totalValue !== "" ? totalNumber : (queue.limits.total?.current ?? null);
  const resultingConflict =
    hasTotal &&
    !perKeyInvalid &&
    !totalInvalid &&
    resultingPerKey !== null &&
    resultingTotal !== null &&
    resultingPerKey > resultingTotal;
  const currentConflictGap =
    hasTotal && queue.limits.perKey.current !== null && queue.limits.total != null
      ? queue.limits.perKey.current - queue.limits.total.current
      : 0;
  const resultingConflictGap =
    resultingConflict && resultingPerKey !== null && resultingTotal !== null
      ? resultingPerKey - resultingTotal
      : 0;
  const boundsConflict =
    resultingConflict && !(currentConflictGap > 0 && resultingConflictGap < currentConflictGap);

  const submitDisabled =
    disabled ||
    (hasTotal
      ? isLoading ||
        perKeyInvalid ||
        totalInvalid ||
        boundsConflict ||
        (perKeyValue === "" && totalValue === "")
      : isLoading || (mode === "percent" ? !percentValid : !concurrencyLimit || limitOverCap));

  const iconLabel = isOverridden ? "Edit override" : "Override limit";

  const handleOpenChange = (open: boolean) => {
    if (open) {
      setPerKeyValue("");
      setTotalValue("");
    }
    setIsOpen(open);
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      {trigger === "icon" ? (
        <TooltipProvider disableHoverableContent={true}>
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="cursor-pointer [&_button]:cursor-pointer">
                <DialogTrigger asChild>
                  <Button
                    type="button"
                    variant="secondary/small-icon"
                    LeadingIcon={AdjustmentsHorizontalIcon}
                    leadingIconClassName="text-text-dimmed"
                    aria-label={iconLabel}
                    disabled={disabled}
                  />
                </DialogTrigger>
              </div>
            </TooltipTrigger>
            <TooltipContent side="right" className="text-xs">
              {disabled ? `You don't have permission to manage ${noun}s` : iconLabel}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : trigger === "button" ? (
        <TooltipProvider disableHoverableContent={true}>
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="cursor-pointer [&_button]:cursor-pointer">
                <DialogTrigger asChild>
                  <Button
                    type="button"
                    variant="secondary/small"
                    LeadingIcon={AdjustmentsHorizontalIcon}
                    leadingIconClassName="text-text-bright"
                    aria-label={
                      isOverridden ? "Edit concurrency override" : "Override concurrency limit"
                    }
                    disabled={disabled}
                  >
                    {isOverridden ? "Edit override" : "Override limit"}
                  </Button>
                </DialogTrigger>
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-[230px] text-xs">
              {disabled
                ? `You don't have permission to manage ${noun}s`
                : hasTotal
                  ? `Override this ${noun}'s per-key and total concurrency limits.`
                  : `Give this ${noun} its own concurrency limit instead of the environment default. Set it as a number or a percentage of the environment limit.`}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : (
        <DialogTrigger asChild>
          <PopoverMenuItem
            icon={AdjustmentsHorizontalIcon}
            title={
              disabled
                ? `You don't have permission to manage ${noun}s`
                : isOverridden
                  ? "Edit override…"
                  : "Override limit…"
            }
            disabled={disabled}
          />
        </DialogTrigger>
      )}
      <DialogContent>
        <DialogHeader>
          {isOverridden ? "Edit concurrency override" : "Override concurrency limit"}
        </DialogHeader>
        <div className="flex flex-col gap-3 pt-3">
          {hasTotal ? (
            isOverridden ? (
              <Paragraph variant="small">
                This {noun}'s limits are currently overridden. Fill a field to change that limit
                (blank fields stay unchanged), or remove the override to restore the limits set in
                code.
              </Paragraph>
            ) : (
              <Paragraph variant="small">
                Override this {noun}'s limits. Per key caps each concurrency key's pool, and total
                caps runs across all keys together. Leave a field blank to keep that limit
                unchanged.
              </Paragraph>
            )
          ) : isOverridden ? (
            <Paragraph variant="small">
              This {noun}'s concurrency limit is currently overridden to {currentLimit}.
              {typeof queue.limits.perKey.base === "number" &&
                ` The original limit set in code was ${queue.limits.perKey.base}.`}{" "}
              You can update the override or remove it to restore the{" "}
              {typeof queue.limits.perKey.base === "number"
                ? "limit set in code"
                : "environment concurrency limit"}
              .
            </Paragraph>
          ) : (
            <Paragraph variant="small">
              Override this {noun}'s concurrency limit. The current limit is {currentLimit}, which
              is set {queue.limits.perKey.current !== null ? "in code" : "by the environment"}.
            </Paragraph>
          )}
          <Form method="post" onSubmit={() => setIsOpen(false)} className="space-y-3">
            <input type="hidden" name="friendlyId" value={queue.id} />
            <input type="hidden" name="noun" value={noun} />
            <input type="hidden" name="mode" value={hasTotal ? "bounds" : mode} />
            {hasTotal ? (
              <>
                <input type="hidden" name="scope" value="bounds" />
                <InputGroup fullWidth>
                  <Label htmlFor="perKeyLimit">Per-key limit</Label>
                  <Input
                    type="number"
                    name="perKeyLimit"
                    id="perKeyLimit"
                    min="0"
                    max={environmentConcurrencyLimit}
                    value={perKeyValue}
                    onChange={(e) => setPerKeyValue(e.target.value)}
                    placeholder={queue.limits.perKey.current?.toString() ?? "No per-key limit"}
                    autoFocus
                  />
                  <Hint className={perKeyOverCap ? "text-warning tabular-nums" : "tabular-nums"}>
                    {perKeyOverCap
                      ? `Can't exceed the environment limit of ${environmentConcurrencyLimit}.`
                      : `The most concurrent runs each concurrency key can use at once.${
                          typeof queue.limits.perKey.base === "number"
                            ? ` Set to ${queue.limits.perKey.base} in code.`
                            : ""
                        }`}
                  </Hint>
                </InputGroup>
                <InputGroup fullWidth>
                  <Label htmlFor="totalLimit">Total limit</Label>
                  <Input
                    type="number"
                    name="totalLimit"
                    id="totalLimit"
                    min="1"
                    max={environmentConcurrencyLimit}
                    value={totalValue}
                    onChange={(e) => setTotalValue(e.target.value)}
                    placeholder={queue.limits.total?.current.toString()}
                  />
                  <Hint className={totalInvalid ? "text-warning tabular-nums" : "tabular-nums"}>
                    {totalInvalid
                      ? totalOverCap
                        ? `Can't exceed the environment limit of ${environmentConcurrencyLimit}.`
                        : "Enter a whole number of 1 or more."
                      : `The most concurrent runs across all keys together. It can't exceed the environment limit of ${environmentConcurrencyLimit}.${
                          typeof queue.limits.total?.base === "number"
                            ? ` Set to ${queue.limits.total.base} in code.`
                            : ""
                        }`}
                  </Hint>
                </InputGroup>
                {boundsConflict ? (
                  <FormError>
                    The per-key limit ({resultingPerKey}) can't exceed the total limit (
                    {resultingTotal}).
                  </FormError>
                ) : resultingConflict ? (
                  <Hint className="text-warning">
                    The per-key limit ({resultingPerKey}) still exceeds the total limit (
                    {resultingTotal}), so only the total applies.
                  </Hint>
                ) : null}
              </>
            ) : (
              <InputGroup fullWidth>
                <Label htmlFor={mode === "percent" ? "percent" : "concurrencyLimit"}>
                  Concurrency limit
                </Label>
                <div className="flex items-center gap-2">
                  <div className="flex-1">
                    {mode === "percent" ? (
                      <Input
                        type="number"
                        name="percent"
                        id="percent"
                        min="1"
                        max="100"
                        step="0.01"
                        value={percent}
                        onChange={(e) => setPercent(e.target.value)}
                        placeholder="100"
                        autoFocus
                        accessory={<span className="pr-1 text-text-dimmed">%</span>}
                      />
                    ) : (
                      <Input
                        type="number"
                        name="concurrencyLimit"
                        id="concurrencyLimit"
                        min="0"
                        max={environmentConcurrencyLimit}
                        value={concurrencyLimit}
                        onChange={(e) => setConcurrencyLimit(e.target.value)}
                        placeholder={currentLimit.toString()}
                        autoFocus
                      />
                    )}
                  </div>
                  <SegmentedControl
                    name="unit"
                    value={mode}
                    className="h-8"
                    options={[
                      { label: "Number", value: "absolute" },
                      { label: "Percent", value: "percent" },
                    ]}
                    onChange={(value) => setMode(value === "percent" ? "percent" : "absolute")}
                  />
                </div>
                {mode === "percent" ? (
                  <Hint className="tabular-nums">
                    {materializedFromPercent !== null
                      ? `${percentNumber}% = ${materializedFromPercent} concurrent ${
                          materializedFromPercent === 1 ? "run" : "runs"
                        } of the environment's ${environmentConcurrencyLimit}. Recalculates automatically when the environment limit changes.`
                      : "Enter a percentage between 1 and 100."}
                  </Hint>
                ) : (
                  <Hint className={limitOverCap ? "text-warning tabular-nums" : "tabular-nums"}>
                    {limitOverCap
                      ? `Can't exceed the environment limit of ${environmentConcurrencyLimit}.`
                      : `The most concurrent runs this ${noun} can use at once. It can't exceed the environment limit of ${environmentConcurrencyLimit}.`}
                  </Hint>
                )}
              </InputGroup>
            )}

            <FormButtons
              defaultAction={{
                name: "action",
                value: "queue-override",
                disabled: submitDisabled,
              }}
              confirmButton={
                <Button
                  type="submit"
                  name="action"
                  value="queue-override"
                  disabled={submitDisabled}
                  variant="primary/medium"
                  LeadingIcon={isLoading && <Spinner color="white" />}
                  shortcut={{ modifiers: ["mod"], key: "enter" }}
                >
                  {isOverridden ? "Update override" : "Override limit"}
                </Button>
              }
              cancelButton={
                <div className="flex items-center justify-between gap-2">
                  {isOverridden && (
                    <Button
                      type="submit"
                      name="action"
                      value="queue-remove-override"
                      disabled={disabled || isLoading}
                      variant="danger/medium"
                    >
                      Remove override
                    </Button>
                  )}
                  <DialogClose asChild>
                    <Button type="button" variant="secondary/medium">
                      Cancel
                    </Button>
                  </DialogClose>
                </div>
              }
            />
          </Form>
        </div>
      </DialogContent>
    </Dialog>
  );
}
