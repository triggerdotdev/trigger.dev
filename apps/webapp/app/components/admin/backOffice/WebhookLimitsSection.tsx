import { Form } from "@remix-run/react";
import { useEffect, useState } from "react";
import { Button } from "~/components/primitives/Buttons";
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

const FIELDS: Array<{ key: keyof WebhookLimits; label: string; hint: string }> = [
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
