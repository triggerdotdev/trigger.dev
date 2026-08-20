import { AdjustmentsHorizontalIcon, PauseIcon, PlayIcon } from "@heroicons/react/20/solid";
import { DialogClose } from "@radix-ui/react-dialog";
import { Form, useNavigation } from "@remix-run/react";
import type { QueueItem } from "@trigger.dev/core/v3/schemas";
import { useEffect, useState } from "react";
import { cn } from "~/utils/cn";
import { Button, type ButtonVariant } from "~/components/primitives/Buttons";
import { Dialog, DialogContent, DialogHeader, DialogTrigger } from "~/components/primitives/Dialog";
import { FormButtons } from "~/components/primitives/FormButtons";
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
}) {
  const [isOpen, setIsOpen] = useState(false);

  const label = queue.paused
    ? `Resumes the "${queue.name}" queue so its runs can be dequeued again.`
    : `Pauses all runs from being dequeued in the "${queue.name}" queue. Any executing runs will continue to run.`;

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
                >
                  {iconOnly
                    ? undefined
                    : withQueueName
                      ? queue.paused
                        ? "Resume this queue…"
                        : "Pause this queue…"
                      : queue.paused
                        ? "Resume"
                        : "Pause"}
                </Button>
              </DialogTrigger>
            </div>
          </TooltipTrigger>
          <TooltipContent side="right" className={"text-xs"}>
            {label}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  ) : (
    <DialogTrigger asChild>
      <PopoverMenuItem
        icon={queue.paused ? PlayIcon : PauseIcon}
        leadingIconClassName={queue.paused ? "text-success" : "text-warning"}
        title={queue.paused ? "Resume..." : "Pause..."}
      />
    </DialogTrigger>
  );

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      {trigger}
      <DialogContent>
        <DialogHeader>{queue.paused ? "Resume queue?" : "Pause queue?"}</DialogHeader>
        <div className="flex flex-col gap-3 pt-3">
          <Paragraph>
            {queue.paused
              ? `This will allow runs to be dequeued in the "${queue.name}" queue again.`
              : `This will pause all runs from being dequeued in the "${queue.name}" queue. Any executing runs will continue to run.`}
          </Paragraph>
          <Form method="post" onSubmit={() => setIsOpen(false)}>
            <input
              type="hidden"
              name="action"
              value={queue.paused ? "queue-resume" : "queue-pause"}
            />
            <input type="hidden" name="friendlyId" value={queue.id} />
            <FormButtons
              confirmButton={
                <Button
                  type="submit"
                  shortcut={{ modifiers: ["mod"], key: "enter" }}
                  variant={queue.paused ? "primary/medium" : "danger/medium"}
                  LeadingIcon={queue.paused ? PlayIcon : PauseIcon}
                >
                  {queue.paused ? "Resume queue" : "Pause queue"}
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
}: {
  queue: QueueItem & { concurrencyLimitOverridePercent: number | null };
  environmentConcurrencyLimit: number;
  /** How to render the dialog trigger. "menu-item" (default) is a PopoverMenuItem for row menus;
   * "button" is a standalone labeled button; "icon" is an icon-only button with the label in a
   * hover tooltip, for compact placements like the detail-page live blocks. */
  trigger?: "menu-item" | "button" | "icon";
}) {
  const navigation = useNavigation();
  const [isOpen, setIsOpen] = useState(false);
  const [mode, setMode] = useState<"absolute" | "percent">(
    queue.concurrencyLimitOverridePercent !== null ? "percent" : "absolute"
  );
  const [concurrencyLimit, setConcurrencyLimit] = useState<string>(
    queue.concurrencyLimit?.toString() ?? environmentConcurrencyLimit.toString()
  );
  const [percent, setPercent] = useState<string>(
    queue.concurrencyLimitOverridePercent?.toString() ?? "100"
  );

  const isOverridden = !!queue.concurrency?.overriddenAt;
  const currentLimit = queue.concurrencyLimit ?? environmentConcurrencyLimit;

  useEffect(() => {
    if (navigation.state === "loading" || navigation.state === "idle") {
      // oxlint-disable-next-line react/react-compiler -- This effect intentionally synchronizes local state after an external or lifecycle change.
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

  const submitDisabled =
    isLoading || (mode === "percent" ? !percentValid : !concurrencyLimit || limitOverCap);

  const iconLabel = isOverridden ? "Edit override" : "Override limit";

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
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
                  />
                </DialogTrigger>
              </div>
            </TooltipTrigger>
            <TooltipContent side="right" className="text-xs">
              {iconLabel}
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
                  >
                    {isOverridden ? "Edit override" : "Override limit"}
                  </Button>
                </DialogTrigger>
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-[230px] text-xs">
              Give this queue its own concurrency limit instead of the environment default. Set it
              as a number or a percentage of the environment limit.
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : (
        <DialogTrigger asChild>
          <PopoverMenuItem
            icon={AdjustmentsHorizontalIcon}
            title={isOverridden ? "Edit override…" : "Override limit…"}
          />
        </DialogTrigger>
      )}
      <DialogContent>
        <DialogHeader>
          {isOverridden ? "Edit concurrency override" : "Override concurrency limit"}
        </DialogHeader>
        <div className="flex flex-col gap-3 pt-3">
          {isOverridden ? (
            <Paragraph variant="small">
              This queue's concurrency limit is currently overridden to {currentLimit}.
              {typeof queue.concurrency?.base === "number" &&
                ` The original limit set in code was ${queue.concurrency.base}.`}{" "}
              You can update the override or remove it to restore the{" "}
              {typeof queue.concurrency?.base === "number"
                ? "limit set in code"
                : "environment concurrency limit"}
              .
            </Paragraph>
          ) : (
            <Paragraph variant="small">
              Override this queue's concurrency limit. The current limit is {currentLimit}, which is
              set {queue.concurrencyLimit !== null ? "in code" : "by the environment"}.
            </Paragraph>
          )}
          <Form method="post" onSubmit={() => setIsOpen(false)} className="space-y-3">
            <input type="hidden" name="friendlyId" value={queue.id} />
            <input type="hidden" name="mode" value={mode} />
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
                    : `The most concurrent runs this queue can use at once. It can't exceed the environment limit of ${environmentConcurrencyLimit}.`}
                </Hint>
              )}
            </InputGroup>

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
                      disabled={isLoading}
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
