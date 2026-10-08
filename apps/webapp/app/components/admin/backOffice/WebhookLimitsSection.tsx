import { Form } from "@remix-run/react";
import { useEffect, useState } from "react";
import { Button } from "~/components/primitives/Buttons";
import { CheckboxWithLabel } from "~/components/primitives/Checkbox";
import { FormError } from "~/components/primitives/FormError";
import { Header2 } from "~/components/primitives/Headers";
import { Hint } from "~/components/primitives/Hint";
import { Input } from "~/components/primitives/Input";
import { Label } from "~/components/primitives/Label";
import { Paragraph } from "~/components/primitives/Paragraph";
import * as Property from "~/components/primitives/PropertyTable";
import type { WebhookLimits, WebhookLimitsConfig } from "~/v3/webhookLimits";

export const WEBHOOK_LIMITS_INTENT = "set-webhook-limits";
export const WEBHOOK_LIMITS_SAVED_VALUE = "webhook-limits";

type FieldErrors = Record<string, string[] | undefined> | null;

type NumericLimit =
  | "maxWaitersPerEnvironment"
  | "maxWaitersPerEndpoint"
  | "concurrency"
  | "deliveryRetentionDays";

const FIELDS: Array<{ key: NumericLimit; label: string; hint: string }> = [
  {
    key: "maxWaitersPerEnvironment",
    label: "Waiters per environment",
    hint: "Live webhook waiters one environment can hold across all its endpoints.",
  },
  {
    key: "maxWaitersPerEndpoint",
    label: "Waiters per endpoint",
    hint: "Live waiters on one endpoint, which is also the most one delivery can resume.",
  },
  {
    key: "concurrency",
    label: "Processing concurrency",
    hint: "Webhook jobs one environment can have in flight at once.",
  },
  {
    key: "deliveryRetentionDays",
    label: "Delivery retention (days)",
    hint: "Days of deliveries the org can see, 1 to 365. Older ones are hidden right away.",
  },
];

type Props = {
  limits: WebhookLimits;
  overrides: WebhookLimitsConfig;
  errors: FieldErrors;
  savedJustNow: boolean;
  isSubmitting: boolean;
};

export function WebhookLimitsSection({
  limits,
  overrides,
  errors,
  savedJustNow,
  isSubmitting,
}: Props) {
  const hasFieldErrors = !!errors && Object.keys(errors).length > 0;
  const fieldError = (field: string) =>
    errors && field in errors ? errors[field]?.[0] : undefined;

  const [isEditing, setIsEditing] = useState(hasFieldErrors);

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- This effect intentionally synchronizes local state after an external or lifecycle change.
    if (hasFieldErrors) setIsEditing(true);
  }, [hasFieldErrors]);

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- This effect intentionally synchronizes local state after an external or lifecycle change.
    if (savedJustNow && !hasFieldErrors) setIsEditing(false);
  }, [savedJustNow, hasFieldErrors]);

  return (
    <section className="flex flex-col gap-3 rounded-md border border-grid-bright bg-background-bright p-4">
      <div className="flex items-center justify-between">
        <Header2>Webhook limits</Header2>
        {!isEditing && (
          <Button
            variant="tertiary/small"
            onClick={() => setIsEditing(true)}
            disabled={isSubmitting}
          >
            Edit
          </Button>
        )}
      </div>
      <Paragraph variant="small" className="text-text-dimmed">
        Set by the org's plan. A blank field uses the system default.
      </Paragraph>

      {savedJustNow && (
        <div className="rounded-md border border-green-600/40 bg-green-600/10 px-3 py-2">
          <Paragraph variant="small" className="text-green-500">
            Saved.
          </Paragraph>
        </div>
      )}

      {!isEditing ? (
        <Property.Table>
          {FIELDS.map((field) => (
            <Property.Item key={field.key}>
              <Property.Label>{field.label}</Property.Label>
              <Property.Value>
                {limits[field.key].toLocaleString()}
                <span className="text-text-dimmed">
                  {overrides[field.key] !== undefined ? " (org)" : " (default)"}
                </span>
              </Property.Value>
            </Property.Item>
          ))}
          <Property.Item>
            <Property.Label>Delivery storage</Property.Label>
            <Property.Value>
              {limits.deliveryStorageDays.toLocaleString()} days
              <span className="text-text-dimmed">
                {limits.deliveryRetentionStrict
                  ? " (deleted at retention)"
                  : " (hidden after retention)"}
              </span>
            </Property.Value>
          </Property.Item>
        </Property.Table>
      ) : (
        <Form method="post" className="flex flex-col gap-3 pt-2">
          <input type="hidden" name="intent" value={WEBHOOK_LIMITS_INTENT} />
          {FIELDS.map((field) => (
            <div key={field.key} className="flex flex-col gap-1">
              <Label>{field.label}</Label>
              <Input
                name={field.key}
                type="number"
                min={1}
                defaultValue={overrides[field.key]?.toString() ?? ""}
                placeholder={`Default: ${limits[field.key].toLocaleString()}`}
              />
              <Hint>{field.hint}</Hint>
              <FormError>{fieldError(field.key)}</FormError>
            </div>
          ))}
          <div className="flex flex-col gap-1">
            <CheckboxWithLabel
              name="deliveryRetentionStrict"
              value="on"
              variant="simple/small"
              label="Delete deliveries at the retention"
              defaultChecked={overrides.deliveryRetentionStrict === true}
            />
            <Hint>
              Off: deliveries are stored for at least 30 days and hidden after the retention, so an
              upgrade shows older history. On: they are stored only for the retention (rounded up to
              3, 7, 30, 90, 180 or 365 days). Applies to new deliveries.
            </Hint>
          </div>
          <div className="flex items-center gap-2">
            <Button type="submit" variant="primary/medium" disabled={isSubmitting}>
              Save
            </Button>
            <Button
              type="button"
              variant="tertiary/medium"
              onClick={() => setIsEditing(false)}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
          </div>
        </Form>
      )}
    </section>
  );
}
