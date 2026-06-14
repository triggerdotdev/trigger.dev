import { useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { EnvelopeIcon } from "@heroicons/react/20/solid";
import { DialogClose } from "@radix-ui/react-dialog";
import { useFetcher } from "@remix-run/react";
import { type ReactNode, useEffect, useState } from "react";
import { Button } from "~/components/primitives/Buttons";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTrigger,
} from "~/components/primitives/Dialog";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormButtons } from "~/components/primitives/FormButtons";
import { FormError } from "~/components/primitives/FormError";
import { Header3 } from "~/components/primitives/Headers";
import { InputGroup } from "~/components/primitives/InputGroup";
import { InputNumberStepper } from "~/components/primitives/InputNumberStepper";
import { Label } from "~/components/primitives/Label";
import { Paragraph } from "~/components/primitives/Paragraph";
import { SpinnerWhite } from "~/components/primitives/Spinner";
import { PurchaseSchema } from "~/routes/resources.orgs.$organizationSlug.schedules-addon";
import { cn } from "~/utils/cn";
import { formatCurrency, formatNumber } from "~/utils/numberFormatter";

export type SchedulePricing = {
  stepSize: number;
  centsPerStep: number;
};

type Props = {
  /** Action URL the purchase form posts to. */
  actionPath: string;
  schedulePricing: SchedulePricing;
  extraSchedules: number;
  usedSchedules: number;
  maxQuota: number;
  planScheduleLimit: number;
  triggerButton?: ReactNode;
};

export function PurchaseSchedulesModal({
  actionPath,
  schedulePricing,
  extraSchedules,
  usedSchedules,
  maxQuota,
  planScheduleLimit,
  triggerButton,
}: Props) {
  const fetcher = useFetcher();
  const lastSubmission =
    fetcher.data && typeof fetcher.data === "object" && "intent" in fetcher.data
      ? fetcher.data
      : undefined;
  const [form, { amount }] = useForm({
    id: "purchase-schedules",
    lastSubmission: lastSubmission as any,
    onValidate({ formData }) {
      return parse(formData, { schema: PurchaseSchema });
    },
    shouldRevalidate: "onSubmit",
  });

  const stepSize = schedulePricing.stepSize;
  const [bundles, setBundles] = useState(Math.round(extraSchedules / stepSize));
  const amountValue = bundles * stepSize;
  const isLoading = fetcher.state !== "idle";

  const [open, setOpen] = useState(false);
  // Reset the bundle stepper to the user's current extra-schedules count on
  // each open. Earlier this only re-synced when `extraSchedules`/`stepSize`
  // props changed, so if the user opened the modal, typed a value, cancelled,
  // and reopened without purchasing, the stale draft persisted.
  useEffect(() => {
    if (open) setBundles(Math.round(extraSchedules / stepSize));
  }, [open, extraSchedules, stepSize]);

  useEffect(() => {
    const data = fetcher.data;
    if (
      fetcher.state === "idle" &&
      data !== null &&
      typeof data === "object" &&
      "ok" in data &&
      data.ok
    ) {
      setOpen(false);
    }
  }, [fetcher.state, fetcher.data]);

  const state = updateScheduleState({
    value: amountValue,
    existingValue: extraSchedules,
    quota: maxQuota,
    usedSchedules,
    planScheduleLimit,
  });
  const changeClassName =
    state === "decrease" ? "text-error" : state === "increase" ? "text-success" : undefined;

  const pricePerSchedule = schedulePricing.centsPerStep / stepSize / 100;
  const pricePerStep = schedulePricing.centsPerStep / 100;
  const stepUnit = formatNumber(stepSize);
  const title = extraSchedules === 0 ? "Purchase extra schedules…" : "Add/remove extra schedules…";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {triggerButton ?? (
          <Button variant="primary/small" onClick={() => setOpen(true)}>
            {title}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>{title}</DialogHeader>
        <fetcher.Form method="post" action={actionPath} {...form.props}>
          <div className="flex flex-col gap-4 pt-2">
            <div className="flex flex-col gap-1">
              <Paragraph variant="small/bright">
                Schedules are purchased in bundles of {stepUnit}, at{" "}
                {formatCurrency(pricePerStep, false)}/month per bundle. Reducing will take effect at
                the start of the next billing cycle (1st of the month).
              </Paragraph>
            </div>
            <Fieldset>
              <InputGroup fullWidth>
                <Label htmlFor="schedule-bundles" className="text-text-dimmed">
                  Bundles of {stepUnit} schedules
                </Label>
                <InputNumberStepper
                  id="schedule-bundles"
                  step={1}
                  min={0}
                  value={bundles}
                  onChange={(e) => setBundles(Number(e.target.value))}
                  disabled={isLoading}
                />
                <input type="hidden" name="amount" value={amountValue} />
                <Paragraph variant="small" className="text-text-dimmed">
                  {formatNumber(bundles)} {bundles === 1 ? "bundle" : "bundles"} ={" "}
                  {formatNumber(amountValue)} schedules
                </Paragraph>
                <FormError id={amount.errorId}>
                  {amount.error ?? amount.initialError?.[""]?.[0]}
                </FormError>
                <FormError>{form.error}</FormError>
              </InputGroup>
            </Fieldset>
            {state === "need_to_delete" ? (
              <div className="flex flex-col pb-3">
                <Paragraph variant="small" className="text-warning" spacing>
                  You need to delete{" "}
                  {formatNumber(usedSchedules - (planScheduleLimit + amountValue))} more{" "}
                  {usedSchedules - (planScheduleLimit + amountValue) === 1
                    ? "schedule"
                    : "schedules"}{" "}
                  before you can reduce to this level.
                </Paragraph>
              </div>
            ) : state === "above_quota" ? (
              <div className="flex flex-col pb-3">
                <Paragraph variant="small" className="text-warning" spacing>
                  Currently you can only have up to {formatNumber(maxQuota)} extra schedules. Send a
                  request below to lift your current limit. We'll get back to you soon.
                </Paragraph>
              </div>
            ) : (
              <div className="flex flex-col pb-3 tabular-nums">
                <div className="grid grid-cols-2 border-b border-grid-dimmed pb-1">
                  <Header3 className="font-normal text-text-dimmed">Summary</Header3>
                  <Header3 className="justify-self-end font-normal text-text-dimmed">Total</Header3>
                </div>
                <div className="grid grid-cols-2 pt-2">
                  <Header3 className="pb-0 font-normal text-text-dimmed">
                    <span className="text-text-bright">{formatNumber(extraSchedules)}</span> current
                    extra
                  </Header3>
                  <Header3 className="justify-self-end font-normal text-text-bright">
                    {formatCurrency(extraSchedules * pricePerSchedule, true)}
                  </Header3>
                </div>
                <div className="grid grid-cols-2 text-xs">
                  <span className="text-text-dimmed">
                    ({formatNumber(extraSchedules)}{" "}
                    {extraSchedules === 1 ? "schedule" : "schedules"})
                  </span>
                  <span className="justify-self-end text-text-dimmed">/mth</span>
                </div>
                <div className="grid grid-cols-2 pt-2">
                  <Header3 className={cn("pb-0 font-normal", changeClassName)}>
                    {state === "increase" ? "+" : null}
                    {formatNumber(amountValue - extraSchedules)}
                  </Header3>
                  <Header3 className={cn("justify-self-end font-normal", changeClassName)}>
                    {state === "increase" ? "+" : null}
                    {formatCurrency((amountValue - extraSchedules) * pricePerSchedule, true)}
                  </Header3>
                </div>
                <div className="grid grid-cols-2 text-xs">
                  <span className="text-text-dimmed">
                    ({formatNumber(Math.abs(amountValue - extraSchedules))}{" "}
                    {Math.abs(amountValue - extraSchedules) === 1 ? "schedule" : "schedules"} @{" "}
                    {formatCurrency(pricePerStep, false)}/mth per {stepUnit})
                  </span>
                  <span className="justify-self-end text-text-dimmed">/mth</span>
                </div>
                <div className="grid grid-cols-2 pt-2">
                  <Header3 className="pb-0 font-normal text-text-dimmed">
                    <span className="text-text-bright">{formatNumber(amountValue)}</span> new total
                  </Header3>
                  <Header3 className="justify-self-end font-normal text-text-bright">
                    {formatCurrency(amountValue * pricePerSchedule, true)}
                  </Header3>
                </div>
                <div className="grid grid-cols-2 text-xs">
                  <span className="text-text-dimmed">
                    ({formatNumber(amountValue)} {amountValue === 1 ? "schedule" : "schedules"})
                  </span>
                  <span className="justify-self-end text-text-dimmed">/mth</span>
                </div>
              </div>
            )}
          </div>
          <FormButtons
            confirmButton={
              state === "above_quota" ? (
                <>
                  <input type="hidden" name="action" value="quota-increase" />
                  <Button
                    LeadingIcon={isLoading ? SpinnerWhite : EnvelopeIcon}
                    variant="primary/medium"
                    type="submit"
                    disabled={isLoading}
                  >
                    <span className="tabular-nums text-text-bright">{`Send request for ${formatNumber(
                      amountValue
                    )}`}</span>
                  </Button>
                </>
              ) : state === "decrease" || state === "need_to_delete" ? (
                <>
                  <input type="hidden" name="action" value="purchase" />
                  <Button
                    variant="danger/medium"
                    type="submit"
                    disabled={isLoading || state === "need_to_delete"}
                    LeadingIcon={isLoading ? SpinnerWhite : undefined}
                  >
                    <span className="tabular-nums text-text-bright">{`Remove ${formatNumber(
                      extraSchedules - amountValue
                    )} ${extraSchedules - amountValue === 1 ? "schedule" : "schedules"}`}</span>
                  </Button>
                </>
              ) : (
                <>
                  <input type="hidden" name="action" value="purchase" />
                  <Button
                    variant="primary/medium"
                    type="submit"
                    disabled={isLoading || state === "no_change"}
                    LeadingIcon={isLoading ? SpinnerWhite : undefined}
                  >
                    <span className="tabular-nums text-text-bright">{`Purchase ${formatNumber(
                      amountValue - extraSchedules
                    )} ${amountValue - extraSchedules === 1 ? "schedule" : "schedules"}`}</span>
                  </Button>
                </>
              )
            }
            cancelButton={
              <DialogClose asChild>
                <Button variant="secondary/medium" disabled={isLoading}>
                  Cancel
                </Button>
              </DialogClose>
            }
          />
        </fetcher.Form>
      </DialogContent>
    </Dialog>
  );
}

function updateScheduleState({
  value,
  existingValue,
  quota,
  usedSchedules,
  planScheduleLimit,
}: {
  value: number;
  existingValue: number;
  quota: number;
  usedSchedules: number;
  planScheduleLimit: number;
}): "no_change" | "increase" | "decrease" | "above_quota" | "need_to_delete" {
  if (value === existingValue) return "no_change";
  if (value < existingValue) {
    const newTotalLimit = planScheduleLimit + value;
    if (usedSchedules > newTotalLimit) {
      return "need_to_delete";
    }
    return "decrease";
  }
  if (value > quota) return "above_quota";
  return "increase";
}
