import { useFetcher } from "@remix-run/react";
import type { RuntimeEnvironmentType } from "@trigger.dev/database";
import { useEffect, useRef, useState } from "react";
import { AlertChannelForm } from "~/components/alerts/AlertChannelForm";
import { environmentFullTitle } from "~/components/environments/EnvironmentLabel";
import { CheckboxWithLabel } from "~/components/primitives/Checkbox";
import { Dialog, DialogContent, DialogHeader } from "~/components/primitives/Dialog";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";

const ENVIRONMENT_TYPES: RuntimeEnvironmentType[] = [
  "PRODUCTION",
  "STAGING",
  "DEVELOPMENT",
  "PREVIEW",
];

type EditableChannel = {
  id: string;
  type: "EMAIL" | "SLACK" | "WEBHOOK";
  environmentTypes: RuntimeEnvironmentType[];
  properties?:
    | { type: "EMAIL"; email: string }
    | { type: "WEBHOOK"; url: string }
    | { type: "SLACK"; channelId: string; channelName: string };
};

function channelValue(properties: EditableChannel["properties"]) {
  switch (properties?.type) {
    case "EMAIL":
      return properties.email;
    case "WEBHOOK":
      return properties.url;
    case "SLACK":
      return `${properties.channelId}/${properties.channelName}`;
  }
}

export function EditChannelDialog({
  channel,
  form,
  action,
  redirectTo,
  onClose,
}: {
  channel: EditableChannel;
  form: Pick<React.ComponentProps<typeof AlertChannelForm>, "slack" | "emailAlertsEnabled">;
  action: string;
  redirectTo: string;
  onClose: () => void;
}) {
  const fetcher = useFetcher<{ status?: string }>();
  const [selected, setSelected] = useState(channel.environmentTypes);
  const submitted = useRef(false);

  useEffect(() => {
    if (fetcher.state !== "idle") {
      submitted.current = true;
    } else if (submitted.current && !fetcher.data?.status) {
      onClose();
    }
  }, [fetcher.state, fetcher.data]); // eslint-disable-line react-hooks/exhaustive-deps -- close once per successful submit

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>Edit channel</DialogHeader>
        <AlertChannelForm
          inline
          mode="edit"
          intent="update"
          slack={form.slack}
          emailAlertsEnabled={form.emailAlertsEnabled}
          defaultType={channel.type}
          defaultChannelValue={channelValue(channel.properties)}
          fetcher={fetcher}
          action={action}
          onClose={onClose}
          submitDisabled={selected.length === 0}
          extraFields={
            <>
              <input type="hidden" name="id" value={channel.id} />
              <input type="hidden" name="redirectTo" value={redirectTo} />
              <InputGroup fullWidth>
                <Label>Environments</Label>
                <div className="flex flex-col gap-2">
                  {ENVIRONMENT_TYPES.map((type) => (
                    <CheckboxWithLabel
                      key={type}
                      name="environmentTypes"
                      value={type}
                      label={environmentFullTitle({ type })}
                      defaultChecked={channel.environmentTypes.includes(type)}
                      onChange={(checked) =>
                        setSelected((prev) =>
                          checked ? [...prev, type] : prev.filter((t) => t !== type)
                        )
                      }
                    />
                  ))}
                </div>
              </InputGroup>
            </>
          }
        />
      </DialogContent>
    </Dialog>
  );
}
