import { Form } from "@remix-run/react";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Switch } from "~/components/primitives/Switch";

interface MfaToggleProps {
  isEnabled: boolean;
  onToggle: (enabled: boolean) => void;
}

export function MfaToggle({ isEnabled, onToggle }: MfaToggleProps) {
  return (
    <Form method="post" className="w-full">
      <InputGroup className="mb-4">
        <Label>Multi-factor authentication</Label>
        <Paragraph variant="small">
          Enable an extra layer of security by requiring a one-time code from your authenticator
          app (TOTP) each time you log in.
        </Paragraph>
      </InputGroup>
      <div className="flex items-center justify-between">
        <Switch
          id="mfa"
          variant="medium"
          label={isEnabled ? "Enabled" : "Enable"}
          labelPosition="right"
          className="-ml-2 w-fit pr-3"
          checked={isEnabled}
          onCheckedChange={onToggle}
        />
      </div>
    </Form>
  );
}