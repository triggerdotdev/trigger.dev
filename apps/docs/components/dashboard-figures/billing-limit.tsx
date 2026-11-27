// The Billing limit section of the organization's Billing limits settings page, with Custom limit
// chosen and an amount typed in (so Save billing limit shows). Drawn from source: the local
// dashboard has no billing. The webapp files it mirrors are its `sources` in
// lib/dashboard-figures.ts.
import { Circle } from "lucide-react";
import type { ReactNode } from "react";
import { Button, SectionHeader } from "./chrome";
import { CheckboxBox, FormButtons } from "./form-parts";
import * as I from "./icons";

// The dashboard's `lg:` grid classes, resolved: the figure always draws the desktop layout.
const row = "grid grid-cols-2 items-start gap-x-4 gap-y-2";

/** RadioButton.tsx, variant "description". */
function RadioDescription({
  checked,
  label,
  description,
  mark,
}: {
  checked?: boolean;
  label: ReactNode;
  description: ReactNode;
  mark?: string;
}) {
  return (
    <div
      data-mark={mark}
      className={`group flex items-start gap-x-2 w-full p-2.5 rounded-md border shadow-xs ${checked ? "border-border-selected bg-surface-selected" : "border-border-bright/50 bg-background-bright"}`}
    >
      <div
        className={`aspect-square h-4 w-4 shrink-0 overflow-hidden rounded-full border mt-0 ${checked ? "border-indigo-500" : "border-border-bright"}`}
      >
        {checked && (
          <span className="flex h-full w-full items-center justify-center rounded-full bg-indigo-600">
            <Circle className="size-2 fill-white text-white dark:fill-text-bright dark:text-text-bright" />
          </span>
        )}
      </div>
      <div>
        <div className="flex items-center gap-x-2">
          <span className="text-text-bright font-semibold -mt-0.5 text-left text-sm">{label}</span>
        </div>
        <div className="font-sans text-sm font-medium text-text-dimmed mt-0 text-left">
          {description}
        </div>
      </div>
    </div>
  );
}

/** Input.tsx (medium) with a "$" icon, as the billing forms use it. */
function DollarInput({ value, className = "w-full" }: { value: string; className?: string }) {
  return (
    <div
      className={`flex items-center px-1 h-8 rounded border border-border-bright/50 shadow-xs bg-input-bg ${className}`}
    >
      <span className="-mt-0.5 block pl-1.5 pr-2 text-sm font-semibold text-text-dimmed">$</span>
      <div className="grow h-full w-full text-text-bright bg-transparent pl-px pr-1.5 rounded text-sm leading-8">
        {value}
      </div>
    </div>
  );
}

export function BillingLimitFigure() {
  return (
    <div className="h-full bg-background-dimmed text-text-dimmed px-4 py-6">
      <SectionHeader title="Billing limit">
        Set a monthly compute spend limit for your organization. When the limit is reached, billable
        environments enter a grace period before new triggers are rejected.
      </SectionHeader>
      <div className="flex flex-col gap-y-5">
        <div className="flex flex-col gap-2">
          <div className={row}>
            <RadioDescription
              mark="plan"
              label={<span className="inline-flex items-center">My plan limit ($50.00)</span>}
              description="Pause billable environments when monthly spend reaches $50.00."
            />
            <div className="relative" />
          </div>
          <div className={row}>
            <div className="flex flex-col gap-2">
              <RadioDescription
                checked
                mark="custom"
                label="Custom limit"
                description="Set your own monthly spend threshold."
              />
              <div data-mark="amount" className="grid w-full items-center gap-1.5 mb-1 mt-0.5">
                <DollarInput value="250" />
              </div>
            </div>
            <div className="relative">
              <div className="opacity-100 absolute w-full text-sm">
                <div className="flex w-full items-start gap-2 rounded-md border pl-2 pr-2 shadow-md backdrop-blur-xs py-2.5 border-grid-bright bg-background-bright">
                  <div className="flex w-full items-start gap-2.5">
                    <I.InformationCircleIcon className="h-5 w-5 shrink-0 text-text-dimmed" />
                    <span>
                      When this limit is reached, queued runs will be held for 24 hours, then new
                      triggers will be rejected until you increase or remove the limit. Limits are
                      enforced with a short delay, so spend may briefly exceed the limit before
                      grace begins. See our{" "}
                      <span className="inline-text-link text-text-link inline-flex gap-0.5 items-center">
                        terms
                      </span>{" "}
                      for refund policy details.
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div className={row}>
            <RadioDescription
              mark="none"
              label="I don't want a billing limit"
              description="Runs continue without protection against runaway usage."
            />
            <div className="relative" />
          </div>
        </div>
        <div data-mark="cancel-runs" className="group flex items-start gap-x-2 w-fit pr-4 mt-4">
          <CheckboxBox />
          <div>
            <div className="flex items-center gap-x-2">
              <span className="text-sm text-text-bright mt-0.5">
                Cancel in-progress runs when this limit is reached
              </span>
            </div>
          </div>
        </div>
        <FormButtons
          confirm={
            <Button variant="primary" mark="save" markBadge="left">
              Save billing limit
            </Button>
          }
        />
      </div>
    </div>
  );
}
