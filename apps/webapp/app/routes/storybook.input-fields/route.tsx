import { Form } from "@remix-run/react";
import { EnvironmentLabel } from "~/components/environments/EnvironmentLabel";
import { MainCenteredContainer } from "~/components/layout/AppLayout";
import { Button } from "~/components/primitives/Buttons";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormButtons } from "~/components/primitives/FormButtons";
import { FormError } from "~/components/primitives/FormError";
import { FormTitle } from "~/components/primitives/FormTitle";
import { Hint } from "~/components/primitives/Hint";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";

export default function Story() {
  return (
    <div className="flex gap-16">
      <InputFieldSet />
      <InputFieldSet disabled />
    </div>
  );
}

function InputFieldSet({ disabled }: { disabled?: boolean }) {
  return (
    <div>
      <div className="m-8 flex w-64 flex-col gap-4">
        <Input disabled={disabled} variant="large" placeholder="Name" autoFocus type="text" />
        <Input disabled={disabled} variant="medium" placeholder="Name" type="text" />
        <Input disabled={disabled} variant="small" placeholder="Name" type="text" />
        <Input disabled={disabled} variant="tertiary" placeholder="Name" type="text" />
      </div>
      <div className="m-8 flex w-64 flex-col gap-4">
        <Input
          disabled={disabled}
          variant="large"
          placeholder="Search"
          icon="search"
          shortcut="⌘K"
        />
        <Input
          disabled={disabled}
          variant="medium"
          placeholder="Search"
          icon="search"
          shortcut="⌘K"
        />
        <Input
          disabled={disabled}
          variant="small"
          placeholder="Search"
          icon="search"
          shortcut="⌘K"
        />
        <Input
          disabled={disabled}
          variant="tertiary"
          placeholder="Search"
          icon="search"
          shortcut="⌘K"
        />
      </div>
      <div className="m-8 flex w-64 flex-col gap-4">
        <Input
          disabled={disabled}
          variant="large"
          placeholder="Search"
          icon={<EnvironmentLabel environment={{ type: "DEVELOPMENT" }} />}
          shortcut="⌘K"
        />
        <Input
          disabled={disabled}
          variant="medium"
          placeholder="Search"
          icon={<EnvironmentLabel environment={{ type: "DEVELOPMENT" }} />}
          shortcut="⌘K"
        />
        <Input
          disabled={disabled}
          variant="small"
          placeholder="Search"
          icon={<EnvironmentLabel environment={{ type: "DEVELOPMENT" }} />}
          shortcut="⌘K"
        />
        <Input
          disabled={disabled}
          variant="tertiary"
          placeholder="Search"
          icon={<EnvironmentLabel environment={{ type: "DEVELOPMENT" }} />}
          shortcut="⌘K"
        />
        <Input
          disabled={disabled}
          variant="tertiary"
          placeholder="Search"
          icon={<EnvironmentLabel environment={{ type: "STAGING" }} />}
          shortcut="⌘K"
        />
        <Input
          disabled={disabled}
          variant="tertiary"
          placeholder="Search"
          icon={<EnvironmentLabel environment={{ type: "PRODUCTION" }} />}
          shortcut="⌘K"
        />
      </div>
    </div>
  );
}
