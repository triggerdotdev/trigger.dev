import { Form } from "@remix-run/react";
import { useEffect, useState } from "react";
import { Button } from "~/components/primitives/Buttons";
import { FormError } from "~/components/primitives/FormError";
import { Header2 } from "~/components/primitives/Headers";
import { Input } from "~/components/primitives/Input";
import { Label } from "~/components/primitives/Label";
import { Paragraph } from "~/components/primitives/Paragraph";
import * as Property from "~/components/primitives/PropertyTable";

export const MAX_PROJECTS_INTENT = "set-max-projects";
export const MAX_PROJECTS_SAVED_VALUE = "max-projects";

type FieldErrors = Record<string, string[] | undefined> | null;

type Props = {
  maximumProjectCount: number;
  errors: FieldErrors;
  savedJustNow: boolean;
  isSubmitting: boolean;
};

export function MaxProjectsSection({
  maximumProjectCount,
  errors,
  savedJustNow,
  isSubmitting,
}: Props) {
  const hasFieldErrors = !!errors && Object.keys(errors).length > 0;
  const fieldError = (field: string) =>
    errors && field in errors ? errors[field]?.[0] : undefined;

  const [isEditing, setIsEditing] = useState(hasFieldErrors);
  const [value, setValue] = useState(String(maximumProjectCount));

  useEffect(() => {
    if (hasFieldErrors) setIsEditing(true);
  }, [hasFieldErrors]);

  useEffect(() => {
    if (savedJustNow && !hasFieldErrors) setIsEditing(false);
  }, [savedJustNow, hasFieldErrors]);

  return (
    <section className="flex flex-col gap-3 rounded-md border border-charcoal-700 bg-charcoal-800 p-4">
      <div className="flex items-center justify-between">
        <Header2>Maximum projects</Header2>
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

      {savedJustNow && (
        <div className="rounded-md border border-green-600/40 bg-green-600/10 px-3 py-2">
          <Paragraph variant="small" className="text-green-500">
            Saved.
          </Paragraph>
        </div>
      )}

      {!isEditing ? (
        <Property.Table>
          <Property.Item>
            <Property.Label>Limit</Property.Label>
            <Property.Value>
              {maximumProjectCount.toLocaleString()}
            </Property.Value>
          </Property.Item>
        </Property.Table>
      ) : (
        <Form method="post" className="flex flex-col gap-3 pt-2">
          <input type="hidden" name="intent" value={MAX_PROJECTS_INTENT} />
          <div className="flex flex-col gap-1">
            <Label>Maximum projects</Label>
            <Input
              name="maximumProjectCount"
              type="number"
              min={1}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              required
            />
            <FormError>{fieldError("maximumProjectCount")}</FormError>
          </div>
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
              onClick={() => {
                setValue(String(maximumProjectCount));
                setIsEditing(false);
              }}
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
