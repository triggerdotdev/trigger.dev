import { Form } from "@remix-run/react";
import { useEffect, useState } from "react";
import { Button } from "~/components/primitives/Buttons";
import { FormError } from "~/components/primitives/FormError";
import { Header2 } from "~/components/primitives/Headers";
import { Input } from "~/components/primitives/Input";
import { Label } from "~/components/primitives/Label";
import { Paragraph } from "~/components/primitives/Paragraph";
import * as Property from "~/components/primitives/PropertyTable";

export const CONCURRENCY_QUOTA_INTENT = "set-concurrency-quota";
export const CONCURRENCY_QUOTA_SAVED_VALUE = "concurrency-quota";

type FieldErrors = Record<string, string[] | undefined> | null;

type Props = {
  currentQuota: number;
  purchased: number;
  errors: FieldErrors;
  formError: string | null;
  savedJustNow: boolean;
  isSubmitting: boolean;
};

export function ConcurrencyQuotaSection({
  currentQuota,
  purchased,
  errors,
  formError,
  savedJustNow,
  isSubmitting,
}: Props) {
  const hasFieldErrors = !!errors && Object.keys(errors).length > 0;
  const fieldError = (field: string) =>
    errors && field in errors ? errors[field]?.[0] : undefined;

  const [isEditing, setIsEditing] = useState(hasFieldErrors || !!formError);
  const [value, setValue] = useState(String(currentQuota));

  useEffect(() => {
    if (hasFieldErrors || formError) setIsEditing(true);
  }, [hasFieldErrors, formError]);

  useEffect(() => {
    if (savedJustNow && !hasFieldErrors && !formError) setIsEditing(false);
  }, [savedJustNow, hasFieldErrors, formError]);

  const cancelEdit = () => {
    setValue(String(currentQuota));
    setIsEditing(false);
  };

  const trimmedValue = value.trim();
  const parsed = Number(trimmedValue);
  const isValidPreview =
    trimmedValue.length > 0 &&
    Number.isInteger(parsed) &&
    parsed >= 0;
  const delta = isValidPreview ? parsed - currentQuota : 0;
  const deltaLabel =
    delta > 0
      ? `+${delta.toLocaleString()}`
      : delta < 0
        ? delta.toLocaleString()
        : "no change";
  const headroomAfter = isValidPreview ? parsed - purchased : 0;

  return (
    <section className="flex flex-col gap-3 rounded-md border border-charcoal-700 bg-charcoal-800 p-4">
      <div className="flex items-center justify-between">
        <Header2>Concurrency quota</Header2>
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

      <Paragraph variant="small">
        Cap on how much extra concurrency this org can purchase. Increases
        unlock self-serve purchase up to the new cap; the org still has to
        complete the purchase from the billing flow.
      </Paragraph>

      {savedJustNow && (
        <div className="rounded-md border border-green-600/40 bg-green-600/10 px-3 py-2">
          <Paragraph variant="small" className="text-green-500">
            Saved.
          </Paragraph>
        </div>
      )}

      {formError && (
        <div className="rounded-md border border-red-600/40 bg-red-600/10 px-3 py-2">
          <Paragraph variant="small" className="text-red-500">
            {formError}
          </Paragraph>
        </div>
      )}

      {!isEditing ? (
        <Property.Table>
          <Property.Item>
            <Property.Label>Max extra concurrency this org can purchase on top of their plan</Property.Label>
            <Property.Value>{currentQuota.toLocaleString()}</Property.Value>
          </Property.Item>
          <Property.Item>
            <Property.Label>Already purchased</Property.Label>
            <Property.Value>{purchased.toLocaleString()}</Property.Value>
          </Property.Item>
        </Property.Table>
      ) : (
        <Form method="post" className="flex flex-col gap-3 pt-2">
          <input type="hidden" name="intent" value={CONCURRENCY_QUOTA_INTENT} />

          <div className="flex flex-col gap-1">
            <Label>Max extra concurrency this org can purchase on top of their plan</Label>
            <Input
              name="extraConcurrencyQuota"
              type="number"
              min={0}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              required
            />
            <FormError>{fieldError("extraConcurrencyQuota")}</FormError>
          </div>

          {isValidPreview && (
            <div className="rounded-md border border-charcoal-700 bg-charcoal-900 px-3 py-2">
              <Paragraph variant="small">
                Cap: {currentQuota.toLocaleString()} →{" "}
                {parsed.toLocaleString()} ({deltaLabel})
              </Paragraph>
              <Paragraph variant="small" className="text-text-dimmed">
                Already purchased: {purchased.toLocaleString()}
              </Paragraph>
              {headroomAfter >= 0 ? (
                <Paragraph variant="small" className="text-text-dimmed">
                  After save: {headroomAfter.toLocaleString()} more buyable.
                </Paragraph>
              ) : (
                <Paragraph variant="small" className="text-amber-500">
                  Below already-purchased — org would be{" "}
                  {(-headroomAfter).toLocaleString()} over the new cap. They'd
                  keep what they have but couldn't buy more until you raise it.
                </Paragraph>
              )}
            </div>
          )}

          <div className="flex items-center gap-2">
            <Button
              type="submit"
              variant="primary/medium"
              disabled={isSubmitting || !value.trim()}
            >
              Save
            </Button>
            <Button
              type="button"
              variant="tertiary/medium"
              onClick={cancelEdit}
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
