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
      <div className="flex w-full items-center justify-between gap-4">
        <InputGroup className="flex-1">
          <Label htmlFor="mfa">Multi-factor authentication</Label>
          <Paragraph variant="small">
            Require a one-time code from your authenticator app (TOTP).
          </Paragraph>
        </InputGroup>
        <div className="flex flex-none items-center">
          <Switch
            id="mfa"
            variant="medium"
            labelPosition="right"
            className="w-fit pr-3"
            checked={isEnabled}
            onCheckedChange={onToggle}
          />
        </div>
      </div>
    </Form>
  );
}
