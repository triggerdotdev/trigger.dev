import { Form } from "@remix-run/react";
import type { AdminAction, AdminPanel } from "@trigger.dev/plugins";
import { useState } from "react";
import { InlineCode } from "~/components/code/InlineCode";
import { Button } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { Dialog, DialogContent, DialogHeader, DialogTrigger } from "~/components/primitives/Dialog";
import { FormButtons } from "~/components/primitives/FormButtons";
import { FormError } from "~/components/primitives/FormError";
import { Header2 } from "~/components/primitives/Headers";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { Paragraph } from "~/components/primitives/Paragraph";
import * as Property from "~/components/primitives/PropertyTable";
import { TextArea } from "~/components/primitives/TextArea";

/** Form intents from a plugin panel are prefixed so they can't collide with the page's own. */
export const PLUGIN_INTENT_PREFIX = "plugin:";
export const PLUGIN_PANEL_SAVED_VALUE = "plugin-panel";

type FieldErrors = Record<string, string[] | undefined> | null;

type Props = {
  panel: AdminPanel;
  errors: FieldErrors;
  savedJustNow: boolean;
  isSubmitting: boolean;
};

/** Renders a section an access policy plugin describes for the back-office organization page. */
export function PluginPanelSection({ panel, errors, savedJustNow, isSubmitting }: Props) {
  return (
    <section className="flex flex-col gap-3 rounded-md border border-grid-bright bg-background-bright p-4">
      <div className="flex items-center justify-between">
        <Header2>{panel.title}</Header2>
        <div className="flex items-center gap-2">
          {panel.actions.map((action) => (
            <ActionDialog
              key={action.intent}
              action={action}
              errors={errors}
              isSubmitting={isSubmitting}
            />
          ))}
        </div>
      </div>

      {savedJustNow && (
        <div className="rounded-md border border-green-600/40 bg-green-600/10 px-3 py-2">
          <Paragraph variant="small" className="text-green-500">
            Saved.
          </Paragraph>
        </div>
      )}

      {panel.properties.length > 0 && (
        <Property.Table>
          {panel.properties.map((property) => (
            <Property.Item key={property.label}>
              <Property.Label>{property.label}</Property.Label>
              <Property.Value>{property.value}</Property.Value>
            </Property.Item>
          ))}
        </Property.Table>
      )}
      <FormError>{errors?.intent?.[0]}</FormError>
    </section>
  );
}

function ActionDialog({
  action,
  errors,
  isSubmitting,
}: {
  action: AdminAction;
  errors: FieldErrors;
  isSubmitting: boolean;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const fieldError = (field: string) =>
    errors && field in errors ? errors[field]?.[0] : undefined;
  const incomplete = action.fields.some((field) => {
    const value = values[field.name] ?? "";
    // Exact match, as the server validates it: "BAN " must not enable the button.
    if (field.mustEqual !== undefined) return value !== field.mustEqual;
    return field.required !== false && value.trim() === "";
  });

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant={`${action.variant}/medium`} disabled={isSubmitting}>
          {action.label}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>{action.label}</DialogHeader>
        <Form method="post" className="flex flex-col gap-4 pt-3">
          <input type="hidden" name="intent" value={`${PLUGIN_INTENT_PREFIX}${action.intent}`} />
          {action.warning && <Callout variant="warning">{action.warning}</Callout>}
          {action.fields.map((field) => (
            <InputGroup key={field.name} className="max-w-full">
              {field.mustEqual !== undefined ? (
                <Paragraph variant="small/bright">
                  Enter <InlineCode variant="small">{field.mustEqual}</InlineCode> to confirm:
                </Paragraph>
              ) : (
                <Label>{field.label}</Label>
              )}
              {field.kind === "textarea" ? (
                <TextArea
                  name={field.name}
                  rows={3}
                  value={values[field.name] ?? ""}
                  onChange={(event) =>
                    setValues((prev) => ({ ...prev, [field.name]: event.target.value }))
                  }
                />
              ) : (
                <Input
                  name={field.name}
                  type="text"
                  placeholder={field.mustEqual}
                  autoComplete="off"
                  fullWidth
                  value={values[field.name] ?? ""}
                  onChange={(event) =>
                    setValues((prev) => ({ ...prev, [field.name]: event.target.value }))
                  }
                />
              )}
              <FormError>{fieldError(field.name)}</FormError>
            </InputGroup>
          ))}
          <FormButtons
            confirmButton={
              <Button
                type="submit"
                variant={`${action.variant}/medium`}
                disabled={isSubmitting || incomplete}
              >
                {action.label}
              </Button>
            }
          />
        </Form>
      </DialogContent>
    </Dialog>
  );
}
