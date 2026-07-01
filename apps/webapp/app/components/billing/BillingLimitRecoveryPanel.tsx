import { useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { Form, useActionData, useNavigation } from "@remix-run/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { Button } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormButtons } from "~/components/primitives/FormButtons";
import { FormError } from "~/components/primitives/FormError";
import { Header2 } from "~/components/primitives/Headers";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Paragraph } from "~/components/primitives/Paragraph";
import { DateTime } from "~/components/primitives/DateTime";
import { RadioGroup, RadioGroupItem } from "~/components/primitives/RadioButton";
import type { BillingLimitResult } from "~/services/billingLimit.schemas";
import { formatCurrency } from "~/utils/numberFormatter";

export const billingLimitRecoveryFormSchema = z
  .object({
    action: z.enum(["increase", "remove"]),
    newAmount: z.coerce
      .number({ invalid_type_error: "Not a valid amount" })
      .positive("Amount must be greater than 0")
      .optional(),
    resumeMode: z.enum(["queue", "new_only"]),
  })
  .superRefine((value, ctx) => {
    if (value.action === "increase" && (value.newAmount === undefined || value.newAmount <= 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Amount must be greater than 0",
        path: ["newAmount"],
      });
    }
  });

type BillingLimitRecoveryActionData = {
  formIntent: "billing-limit-resolve";
  submission: ReturnType<typeof parse<typeof billingLimitRecoveryFormSchema>>;
};

export function BillingLimitRecoveryPanel({
  billingLimit,
  currentSpendCents,
  queuedRunCount,
  suggestedNewLimitDollars,
}: {
  billingLimit: BillingLimitResult & { isConfigured: true };
  currentSpendCents: number;
  queuedRunCount: number;
  suggestedNewLimitDollars: number;
}) {
  const { limitState } = billingLimit;
  const isGrace = limitState.status === "grace";
  const isRejected = limitState.status === "rejected";

  const [action, setAction] = useState<"increase" | "remove">("increase");
  const [newAmount, setNewAmount] = useState(String(suggestedNewLimitDollars));
  const [resumeMode, setResumeMode] = useState<"queue" | "new_only">("queue");
  const newAmountInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setNewAmount(String(suggestedNewLimitDollars));
  }, [suggestedNewLimitDollars]);

  function handleActionChange(value: string) {
    const nextAction = value as typeof action;
    setAction(nextAction);
    if (nextAction === "increase") {
      window.setTimeout(() => newAmountInputRef.current?.focus(), 0);
    }
  }

  const actionData = useActionData<BillingLimitRecoveryActionData>();
  const recoverySubmission =
    actionData?.formIntent === "billing-limit-resolve" ? actionData.submission : undefined;

  const [form, fields] = useForm({
    id: "billing-limit-resolve",
    lastSubmission: recoverySubmission as any,
    shouldRevalidate: "onInput",
    onValidate({ formData }) {
      return parse(formData, { schema: billingLimitRecoveryFormSchema });
    },
    defaultValue: {
      action: "increase",
      newAmount: suggestedNewLimitDollars,
      resumeMode: "queue",
    },
  });

  useEffect(() => {
    form.ref.current?.dispatchEvent(new Event("input", { bubbles: true }));
  }, [action, form.ref, newAmount, resumeMode]);

  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const queuedRunsLabel = useMemo(() => {
    if (queuedRunCount === 0) {
      return null;
    }
    return `~${queuedRunCount.toLocaleString()} run${
      queuedRunCount === 1 ? "" : "s"
    } waiting in queue`;
  }, [queuedRunCount]);

  return (
    <div className="space-y-6">
      <div className="border-b border-grid-dimmed pb-3">
        <Header2 spacing>Action required</Header2>
        <Callout variant="warning">
          <Paragraph variant="small" className="text-yellow-200">
            {isGrace ? (
              <>
                Your organization has reached its billing limit. Processing is paused and new runs
                are queuing. Without action, new triggers block on{" "}
                <DateTime date={limitState.graceEndsAt} includeTime />.
              </>
            ) : (
              "Your organization has exceeded its billing limit. New triggers are blocked until you resolve this."
            )}
          </Paragraph>
        </Callout>
      </div>

      <div className="space-y-2">
        <Paragraph variant="small">
          Current usage: {formatCurrency(currentSpendCents / 100, false)}
        </Paragraph>
        {billingLimit.effectiveAmountCents !== null && (
          <Paragraph variant="small">
            Current limit: {formatCurrency(billingLimit.effectiveAmountCents / 100, false)}
          </Paragraph>
        )}
        {queuedRunsLabel && <Paragraph variant="small">{queuedRunsLabel}</Paragraph>}

        {isRejected && queuedRunsLabel && (
          <Paragraph variant="small">New triggers are currently blocked.</Paragraph>
        )}
      </div>

      <Form method="post" {...form.props}>
        <input type="hidden" name="intent" value="billing-limit-resolve" />
        <input type="hidden" name="action" value={action} />
        <input type="hidden" name="resumeMode" value={resumeMode} />

        <Fieldset className="space-y-6">
          <div className="space-y-3">
            <Header2 spacing className="text-base">
              How would you like to resolve this?
            </Header2>
            <RadioGroup
              value={action}
              onValueChange={handleActionChange}
              className="flex flex-col gap-2"
            >
              <div className="space-y-2">
                <RadioGroupItem
                  id="resolve_action_increase"
                  value="increase"
                  variant="description"
                  label="Increase billing limit"
                  description="Continue running with a higher monthly cap."
                />
                {action === "increase" && (
                  <InputGroup fullWidth>
                    <Input
                      ref={newAmountInputRef}
                      id="new-amount"
                      name="newAmount"
                      type="number"
                      step={0.01}
                      min={0.01}
                      value={newAmount}
                      onChange={(e) => setNewAmount(e.target.value)}
                      placeholder="New limit amount"
                      icon={
                        <span className="-mt-0.5 block pl-1.5 pr-2 text-sm font-semibold text-text-dimmed">
                          $
                        </span>
                      }
                    />
                  </InputGroup>
                )}
                {action === "increase" && fields.newAmount?.error && (
                  <FormError id={fields.newAmount?.errorId}>{fields.newAmount.error}</FormError>
                )}
              </div>

              <RadioGroupItem
                id="resolve_action_remove"
                value="remove"
                variant="description"
                label="Remove billing limit"
                description="Keep going without a ceiling on usage."
              />
            </RadioGroup>
          </div>

          <div className="space-y-3 border-t border-grid-dimmed pt-6">
            <Header2 spacing className="text-base">
              What should happen to queued runs?
            </Header2>
            <RadioGroup
              value={resumeMode}
              onValueChange={(value) => setResumeMode(value as typeof resumeMode)}
              className="flex flex-col gap-2"
            >
              <RadioGroupItem
                id="resume_mode_queue"
                value="queue"
                variant="description"
                label="Resume queued runs"
                description="Everything built up during the pause will run in order."
              />
              <RadioGroupItem
                id="resume_mode_new_only"
                value="new_only"
                variant="description"
                label="Cancel queued runs"
                description="Nothing from the pause is kept — only new triggers going forward."
              />
            </RadioGroup>
          </div>

          <FormButtons
            confirmButton={
              <Button type="submit" variant="primary/medium" disabled={isSubmitting}>
                {isSubmitting ? "Resolving…" : "Resolve"}
              </Button>
            }
          />
        </Fieldset>
      </Form>
    </div>
  );
}
