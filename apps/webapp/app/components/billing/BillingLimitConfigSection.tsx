import { getFormProps,useForm,type SubmissionResult } from "@conform-to/react";

import { parseWithZod } from "@conform-to/zod";
import { Form,useActionData } from "@remix-run/react";
import { useEffect,useMemo,useRef,useState } from "react";
import { z } from "zod";
import { getBillingLimitMode } from "~/components/billing/billingAlertsFormat";
import { formatGracePeriodMs } from "~/components/billing/billingLimitFormat";
import { AnimatedCallout } from "~/components/primitives/AnimatedCallout";
import { Button } from "~/components/primitives/Buttons";
import { CheckboxWithLabel } from "~/components/primitives/Checkbox";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormButtons } from "~/components/primitives/FormButtons";
import { FormError } from "~/components/primitives/FormError";
import { Header2 } from "~/components/primitives/Headers";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Paragraph } from "~/components/primitives/Paragraph";
import { RadioGroup,RadioGroupItem } from "~/components/primitives/RadioButton";
import type { BillingLimitResult } from "~/services/billingLimit.schemas";
import { formatCurrency } from "~/utils/numberFormatter";

export const billingLimitFormSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("none"),
    cancelInProgressRuns: z
      .preprocess((v) => v === "on" || v === true || v === "true", z.boolean())
      .optional(),
  }),
  z.object({
    mode: z.literal("plan"),
    cancelInProgressRuns: z
      .preprocess((v) => v === "on" || v === true || v === "true", z.boolean())
      .optional(),
  }),
  z.object({
    mode: z.literal("custom"),
    amount: z.coerce
      .number({ invalid_type_error: "Not a valid amount" })
      .positive("Amount must be greater than 0"),
    cancelInProgressRuns: z
      .preprocess((v) => v === "on" || v === true || v === "true", z.boolean())
      .optional(),
  }),
]);

type BillingLimitActionData = {
  formIntent: "billing-limit";
  submission: SubmissionResult;
};

export function isBillingLimitFormDirty(input: {
  billingLimit: BillingLimitResult;
  mode: "none" | "plan" | "custom";
  customAmount: string;
  cancelInProgressRuns: boolean;
}): boolean {
  const needsInitialSave = !input.billingLimit.isConfigured;
  const savedMode = getBillingLimitMode(input.billingLimit);
  const savedCustomAmount =
    input.billingLimit.isConfigured && input.billingLimit.mode === "custom"
      ? (input.billingLimit.amountCents / 100).toFixed(2)
      : "";
  const savedCancelInProgressRuns =
    input.billingLimit.isConfigured && input.billingLimit.cancelInProgressRuns;

  const isLimitDirty =
    input.mode !== savedMode ||
    (input.mode === "custom" && input.customAmount !== savedCustomAmount);

  return (
    needsInitialSave || isLimitDirty || input.cancelInProgressRuns !== savedCancelInProgressRuns
  );
}

export function getBillingLimitFormLastSubmission(
  submission: BillingLimitActionData["submission"] | undefined,
  mode: "none" | "plan" | "custom",
  isDirty: boolean
) {
  if (!isDirty || !submission) {
    return undefined;
  }

  if (mode !== "custom" && submission.error?.amount) {
    const { amount: _amount, ...remainingErrors } = submission.error;
    return {
      ...submission,
      error: remainingErrors,
    };
  }

  return submission;
}

type BillingLimitConfigSectionProps = {
  billingLimit: BillingLimitResult;
  planLimitCents: number;
};

export function BillingLimitConfigSection({
  billingLimit,
  planLimitCents,
}: BillingLimitConfigSectionProps) {
  const gracePeriodLabel = formatGracePeriodMs(billingLimit.gracePeriodMs);

  const savedMode = getBillingLimitMode(billingLimit);
  const savedCustomAmount =
    billingLimit.isConfigured && billingLimit.mode === "custom"
      ? (billingLimit.amountCents / 100).toFixed(2)
      : "";
  const savedCancelInProgressRuns = billingLimit.isConfigured && billingLimit.cancelInProgressRuns;

  const [mode, setMode] = useState<"none" | "plan" | "custom">(savedMode);
  const [customAmount, setCustomAmount] = useState(savedCustomAmount);
  const [cancelInProgressRuns, setCancelInProgressRuns] = useState(savedCancelInProgressRuns);
  const customAmountInputRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    setMode(savedMode);
    setCustomAmount(savedCustomAmount);
    setCancelInProgressRuns(savedCancelInProgressRuns);
  }, [savedMode, savedCustomAmount, savedCancelInProgressRuns]);

  function handleModeChange(value: string) {
    const nextMode = value as typeof mode;
    if (mode === "custom" && nextMode !== "custom") {
      setCustomAmount(savedCustomAmount);
    }
    setMode(nextMode);
    if (nextMode === "custom") {
      window.setTimeout(() => customAmountInputRef.current?.focus(), 0);
    }
  }

  const actionData = useActionData<BillingLimitActionData>();
  const limitSubmission =
    actionData?.formIntent === "billing-limit" ? actionData.submission : undefined;

  const _needsInitialSave = !billingLimit.isConfigured;
  const _isLimitDirty =
    mode !== savedMode || (mode === "custom" && customAmount !== savedCustomAmount);
  const isDirty = isBillingLimitFormDirty({
    billingLimit,
    mode,
    customAmount,
    cancelInProgressRuns,
  });
  const lastSubmission = useMemo(
    () => getBillingLimitFormLastSubmission(limitSubmission, mode, isDirty),
    [limitSubmission, mode, isDirty]
  );

  const [form, fields] = useForm({
    id: "billing-limit",
    lastResult: lastSubmission as any,
    shouldRevalidate: "onInput",
    onValidate({ formData }) {
      return parseWithZod(formData, { schema: billingLimitFormSchema });
    },
    defaultValue: {
      mode: savedMode,
    },
  });

  useEffect(() => {
    formRef.current?.dispatchEvent(new Event("input", { bubbles: true }));
  }, [customAmount, mode]);

  const planLimitLabel = formatCurrency(planLimitCents / 100, false);
  const showPlanInfoCallout = mode === "plan";
  const showCustomInfoCallout = mode === "custom";
  const showNoneWarningCallout = mode === "none";

  return (
    <div>
      <div className="mb-3 border-b border-grid-dimmed pb-3">
        <Header2 spacing>Billing limit</Header2>
        <Paragraph variant="small">
          Set a monthly compute spend limit for your organization. When the limit is reached,
          billable environments enter a grace period before new triggers are rejected.
        </Paragraph>
      </div>

      <Form method="post" {...getFormProps(form)} ref={formRef}>
        <input type="hidden" name="intent" value="billing-limit" />
        <Fieldset>
          <input type="hidden" name="mode" value={mode} />

          <RadioGroup value={mode} onValueChange={handleModeChange} className="flex flex-col gap-2">
            <div className="grid grid-cols-1 gap-2 lg:grid-cols-2 lg:items-start lg:gap-x-4 lg:gap-y-2">
              <RadioGroupItem
                id="limit_mode_plan"
                value="plan"
                variant="description"
                label={
                  <span className="inline-flex items-center">{`My plan limit (${planLimitLabel})`}</span>
                }
                description={`Pause billable environments when monthly spend reaches ${planLimitLabel}.`}
              />
              <div className="relative">
                <AnimatedCallout
                  show={showPlanInfoCallout}
                  variant="info"
                  className="absolute w-full text-sm"
                >
                  <LimitReachedCalloutContent
                    gracePeriodLabel={gracePeriodLabel}
                    cancelInProgressRuns={cancelInProgressRuns}
                  />
                </AnimatedCallout>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-2 lg:grid-cols-2 lg:items-start lg:gap-x-4 lg:gap-y-2">
              <div className="flex flex-col gap-2">
                <RadioGroupItem
                  id="limit_mode_custom"
                  value="custom"
                  variant="description"
                  label="Custom limit"
                  description="Set your own monthly spend threshold."
                />
                {mode === "custom" && (
                  <InputGroup fullWidth className="mb-1 mt-0.5">
                    <Input
                      ref={customAmountInputRef}
                      id="custom-amount"
                      name="amount"
                      type="number"
                      step={0.01}
                      min={0.01}
                      value={customAmount}
                      onChange={(e) => setCustomAmount(e.target.value)}
                      placeholder="Custom limit amount"
                      icon={
                        <span className="-mt-0.5 block pl-1.5 pr-2 text-sm font-semibold text-text-dimmed">
                          $
                        </span>
                      }
                      className="pl-px"
                      fullWidth
                    />
                    {fields.amount && (
                      <FormError id={fields.amount.errorId}>{fields.amount.errors}</FormError>
                    )}
                  </InputGroup>
                )}
              </div>
              <div className="relative">
                <AnimatedCallout
                  show={showCustomInfoCallout}
                  variant="info"
                  className="absolute w-full text-sm"
                >
                  <LimitReachedCalloutContent
                    gracePeriodLabel={gracePeriodLabel}
                    cancelInProgressRuns={cancelInProgressRuns}
                  />
                </AnimatedCallout>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-2 lg:grid-cols-2 lg:items-start lg:gap-x-4 lg:gap-y-2">
              <RadioGroupItem
                id="limit_mode_none"
                value="none"
                variant="description"
                label="I don't want a billing limit"
                description="Runs continue without protection against runaway usage."
              />
              <div className="relative">
                <AnimatedCallout
                  show={showNoneWarningCallout}
                  variant="warning"
                  className="absolute w-full"
                >
                  Without a billing limit, runs will continue even if usage spikes unexpectedly. You
                  may have to pay higher fees before you notice.
                </AnimatedCallout>
              </div>
            </div>
          </RadioGroup>

          {mode !== "none" && (
            <CheckboxWithLabel
              className="mt-4"
              name="cancelInProgressRuns"
              id="cancel_in_progress_runs"
              value="on"
              variant="simple/small"
              label="Cancel in-progress runs when this limit is reached"
              defaultChecked={cancelInProgressRuns}
              onChange={setCancelInProgressRuns}
            />
          )}
          <FormButtons
            className={isDirty ? undefined : "invisible"}
            confirmButton={
              <Button type="submit" variant="primary/small" disabled={!isDirty}>
                Save billing limit
              </Button>
            }
          />
        </Fieldset>
      </Form>
    </div>
  );
}

function LimitReachedCalloutContent({
  gracePeriodLabel,
  cancelInProgressRuns,
}: {
  gracePeriodLabel: string;
  cancelInProgressRuns: boolean;
}) {
  return (
    <>
      When this limit is reached, queued runs will be held for {gracePeriodLabel}, then new triggers
      will be rejected until you increase or remove the limit. Limits are enforced with a short
      delay, so spend may briefly exceed the limit before grace begins. See our{" "}
      <a href="https://trigger.dev/terms" className="underline">
        terms
      </a>{" "}
      for refund policy details.
      {cancelInProgressRuns ? (
        <> In-progress runs will be cancelled when the limit is hit.</>
      ) : null}
    </>
  );
}
