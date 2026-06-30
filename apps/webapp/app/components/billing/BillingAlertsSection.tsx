import { getFormProps, getInputProps, useForm, type SubmissionResult } from "@conform-to/react";
import { parseWithZod } from "@conform-to/zod/v4";
import { PlusIcon, TrashIcon } from "@heroicons/react/20/solid";
import { Form, useActionData, useSearchParams } from "@remix-run/react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import {
  emailsMatchSaved,
  getAlertPreviewLimitCents,
  getBillingLimitMode,
  getEffectiveLimitCents,
  hasLegacySpikeAlertLevels,
  isPercentageAlertMode,
  MAX_ABSOLUTE_ALERTS,
  MAX_PERCENTAGE_ALERTS,
  MAX_PERCENTAGE_THRESHOLD,
  previewDollarAmountForPercent,
  storedAlertsToThresholds,
  thresholdsMatchSaved,
  thresholdValuesAreUnique,
  type BillingAlertsFormData,
} from "~/components/billing/billingAlertsFormat";
import { AnimatedCallout } from "~/components/primitives/AnimatedCallout";
import { Button } from "~/components/primitives/Buttons";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormButtons } from "~/components/primitives/FormButtons";
import { FormError } from "~/components/primitives/FormError";
import { Header2 } from "~/components/primitives/Headers";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { Paragraph } from "~/components/primitives/Paragraph";
import { TextLink } from "~/components/primitives/TextLink";
import type { BillingLimitResult } from "~/services/billingLimit.schemas";
import { formatCurrency } from "~/utils/numberFormatter";
import { docsPath } from "~/utils/pathBuilder";

export const billingAlertsSchema = z.object({
  emails: z.preprocess((i) => {
    if (typeof i === "string") return [i];

    if (Array.isArray(i)) {
      const emails = i.filter((v) => typeof v === "string" && v !== "");
      if (emails.length === 0) {
        return [""];
      }
      return emails;
    }

    return [""];
  }, z.string().email().array().nonempty("At least one email is required")),
  alertLevels: z.preprocess(
    (i) => {
      const values = typeof i === "string" ? [i] : Array.isArray(i) ? i : [];
      return values.filter((v) => v !== "").map((v) => Number(v));
    },
    z.number().array().refine(thresholdValuesAreUnique, "Each alert must be unique")
  ),
});

export type { BillingAlertsFormData } from "~/components/billing/billingAlertsFormat";

type BillingAlertsActionData = {
  formIntent: "billing-alerts";
  submission: SubmissionResult;
};

type BillingAlertsSectionProps = {
  alerts: BillingAlertsFormData;
  billingLimit: BillingLimitResult;
  planLimitCents: number;
  alertsResetRequested?: boolean;
};

type ThresholdRow = {
  id: number;
  value: string;
};

function isEmptyThresholdRow(value: string): boolean {
  const parsed = Number(value);
  return value === "" || !Number.isFinite(parsed) || parsed <= 0;
}

function toThresholdRows(values: number[]): ThresholdRow[] {
  return values.map((value, index) => ({ id: index, value: String(value) }));
}

function parseThresholdValues(rows: ThresholdRow[]): number[] {
  return rows
    .map((row) => Number(row.value))
    .filter((value) => Number.isFinite(value) && value > 0);
}

function isDuplicateThresholdRow(rows: ThresholdRow[], index: number): boolean {
  const value = rows[index]?.value;
  if (!value || isEmptyThresholdRow(value)) {
    return false;
  }

  const parsed = Number(value);
  return rows.some(
    (row, rowIndex) =>
      rowIndex !== index && !isEmptyThresholdRow(row.value) && Number(row.value) === parsed
  );
}

export function BillingAlertsSection({
  alerts,
  billingLimit,
  planLimitCents,
  alertsResetRequested = false,
}: BillingAlertsSectionProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [showResetBanner, setShowResetBanner] = useState(alertsResetRequested);

  useEffect(() => {
    if (!alertsResetRequested) {
      return;
    }

    setShowResetBanner(true);

    if (searchParams.get("alertsReset") !== "1") {
      return;
    }

    const next = new URLSearchParams(searchParams);
    next.delete("alertsReset");
    setSearchParams(next, { replace: true });
  }, [alertsResetRequested, searchParams, setSearchParams]);

  const billingLimitMode = getBillingLimitMode(billingLimit);
  const isPercentageMode = isPercentageAlertMode(billingLimitMode);
  const effectiveLimitCents = getEffectiveLimitCents(billingLimit, planLimitCents);
  const alertPreviewLimitCents = getAlertPreviewLimitCents(
    alerts,
    effectiveLimitCents,
    planLimitCents
  );
  const maxAlerts = isPercentageMode ? MAX_PERCENTAGE_ALERTS : MAX_ABSOLUTE_ALERTS;

  const savedThresholds = useMemo(
    () => storedAlertsToThresholds(alerts, billingLimitMode, effectiveLimitCents, planLimitCents),
    [alerts, billingLimitMode, effectiveLimitCents, planLimitCents]
  );
  const savedEmails = useMemo(() => alerts.emails, [alerts.emails]);
  const hasLegacySpikes = useMemo(
    () => hasLegacySpikeAlertLevels(alerts, billingLimitMode, effectiveLimitCents, planLimitCents),
    [alerts, billingLimitMode, effectiveLimitCents, planLimitCents]
  );

  const nextThresholdIdRef = useRef(savedThresholds.length);
  const [thresholdRows, setThresholdRows] = useState<ThresholdRow[]>(() =>
    toThresholdRows(savedThresholds)
  );
  const [emailValues, setEmailValues] = useState<string[]>(
    savedEmails.length > 0 ? [...savedEmails, ""] : [""]
  );
  const actionData = useActionData<BillingAlertsActionData>();
  const alertsSubmission =
    actionData?.formIntent === "billing-alerts" ? actionData.submission : undefined;

  const currentThresholds = parseThresholdValues(thresholdRows);
  const isDirty =
    hasLegacySpikes ||
    !thresholdsMatchSaved(currentThresholds, savedThresholds) ||
    !emailsMatchSaved(emailValues, savedEmails);
  const lastSubmission = isDirty ? alertsSubmission : undefined;

  const [form, { emails, alertLevels }] = useForm<z.infer<typeof billingAlertsSchema>>({
    id: "billing-alerts",
    lastResult: lastSubmission as any,
    shouldRevalidate: "onInput",
    onValidate({ formData }) {
      return parseWithZod(formData, { schema: billingAlertsSchema });
    },
    defaultValue: {
      emails: emailValues,
      alertLevels: savedThresholds.map(String),
    },
  });

  const emailFields = emails.getFieldList();

  useEffect(() => {
    nextThresholdIdRef.current = savedThresholds.length;
    setThresholdRows(toThresholdRows(savedThresholds));
    setEmailValues(savedEmails.length > 0 ? [...savedEmails, ""] : [""]);
  }, [savedThresholds, savedEmails]);

  function updateThresholdRow(index: number, rawValue: string) {
    setThresholdRows((current) =>
      current.map((row, rowIndex) => (rowIndex === index ? { ...row, value: rawValue } : row))
    );
  }

  function removeThreshold(index: number) {
    setThresholdRows((current) => current.filter((_, rowIndex) => rowIndex !== index));
  }

  function addThreshold() {
    if (thresholdRows.length >= maxAlerts) return;
    if (thresholdRows.some((row) => isEmptyThresholdRow(row.value))) return;

    nextThresholdIdRef.current += 1;
    setThresholdRows((current) => [...current, { id: nextThresholdIdRef.current, value: "" }]);
  }

  const hasEmptyThreshold = thresholdRows.some((row) => isEmptyThresholdRow(row.value));
  const hasDuplicateThresholds = !thresholdValuesAreUnique(currentThresholds);
  const canAddThreshold = thresholdRows.length < maxAlerts && !hasEmptyThreshold;
  const showAlertsSave = isDirty && !hasDuplicateThresholds;

  return (
    <div>
      <div className="mb-3 border-b border-grid-dimmed pb-3">
        <Header2 spacing>Billing alerts</Header2>
        <Paragraph variant="small">
          Receive an email when your compute spend crosses different thresholds. You can also learn
          how to{" "}
          <TextLink to={docsPath("how-to-reduce-your-spend")}>reduce your compute spend</TextLink>.
        </Paragraph>
      </div>
      <Form method="post" {...getFormProps(form)}>
        <input type="hidden" name="intent" value="billing-alerts" />
        <Fieldset>
          <AnimatedCallout
            show={showResetBanner}
            variant="warning"
            className="mb-4"
            autoHideMs={5_000}
            onAutoHide={() => setShowResetBanner(false)}
          >
            Billing alerts were reset because they no longer match the selected billing limit
            configuration.
          </AnimatedCallout>

          <div className="space-y-2">
            <Label htmlFor={alertLevels.id}>
              {isPercentageMode ? "Alert me when I reach" : "Monthly spend alerts"}
            </Label>

            <div className="flex flex-col gap-2">
              {thresholdRows.map((row, index) => {
                const parsed = Number(row.value);
                const isDuplicate = isDuplicateThresholdRow(thresholdRows, index);

                return (
                  <div key={row.id} className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                      {isPercentageMode ? (
                        <>
                          <Input
                            name={`${alertLevels.name}[${index}]`}
                            id={`${alertLevels.id}-${index}`}
                            type="number"
                            value={row.value}
                            onChange={(e) => updateThresholdRow(index, e.target.value)}
                            onBlur={(e) => {
                              if (e.target.value === "") return;
                              const clamped = Math.min(
                                MAX_PERCENTAGE_THRESHOLD,
                                Math.max(1, Number(e.target.value))
                              );
                              if (String(clamped) !== e.target.value) {
                                updateThresholdRow(index, String(clamped));
                              }
                            }}
                            min={1}
                            max={MAX_PERCENTAGE_THRESHOLD}
                            step={1}
                            placeholder="75"
                            className="w-24"
                            fullWidth={false}
                          />
                          <span className="text-sm text-text-dimmed">%</span>
                          <span className="text-sm text-text-dimmed">
                            (
                            {formatCurrency(
                              previewDollarAmountForPercent(
                                Number.isFinite(parsed) ? parsed : 0,
                                alertPreviewLimitCents
                              ),
                              false
                            )}
                            )
                          </span>
                        </>
                      ) : (
                        <Input
                          name={`${alertLevels.name}[${index}]`}
                          id={`${alertLevels.id}-${index}`}
                          type="number"
                          value={row.value}
                          onChange={(e) => updateThresholdRow(index, e.target.value)}
                          min={0.01}
                          step={0.01}
                          placeholder="100"
                          icon={
                            <span className="-mt-0.5 block pl-1.5 pr-2 text-sm font-semibold text-text-dimmed">
                              $
                            </span>
                          }
                          className="max-w-xs pl-px"
                          fullWidth={false}
                        />
                      )}

                      <Button
                        type="button"
                        variant="tertiary/small"
                        LeadingIcon={TrashIcon}
                        className="shrink-0"
                        onClick={() => removeThreshold(index)}
                        aria-label="Remove alert"
                      />
                    </div>
                    {isDuplicate && <FormError>This alert threshold is already in use</FormError>}
                  </div>
                );
              })}
            </div>

            <FormError id={alertLevels.errorId}>{alertLevels.errors}</FormError>

            {canAddThreshold && (
              <Button
                type="button"
                variant="tertiary/small"
                LeadingIcon={PlusIcon}
                className="mt-2 w-fit"
                onClick={addThreshold}
              >
                Add alert
              </Button>
            )}
          </div>

          <InputGroup fullWidth className="mt-4">
            <Label htmlFor={emails.id}>Email addresses</Label>
            {emailFields.map((email, index) => {
              const { defaultValue: _emailDefaultValue, ...emailInputProps } = getInputProps(
                email,
                { type: "email" }
              );

              return (
                <Fragment key={email.key}>
                  <Input
                    {...emailInputProps}
                    value={emailValues[index] ?? ""}
                    placeholder={index === 0 ? "Enter an email address" : "Add another email"}
                    onChange={(e) => {
                      const nextValue = e.target.value;
                      setEmailValues((current) => {
                        const next = [...current];
                        next[index] = nextValue;
                        if (
                          emailFields.length === next.length &&
                          next.every((value) => value !== "")
                        ) {
                          form.insert({ name: emails.name });
                          return [...next, ""];
                        }
                        return next;
                      });
                    }}
                    fullWidth
                  />
                  <FormError id={email.errorId}>{email.errors}</FormError>
                </Fragment>
              );
            })}
          </InputGroup>

          <FormButtons
            className={showAlertsSave ? undefined : "invisible"}
            confirmButton={
              <Button type="submit" variant="primary/small" disabled={!showAlertsSave}>
                Update alerts
              </Button>
            }
          />
        </Fieldset>
      </Form>
    </div>
  );
}
