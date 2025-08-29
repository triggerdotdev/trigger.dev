import { MagnifyingGlassIcon } from "@heroicons/react/20/solid";
import { EnvironmentLabel } from "~/components/environments/EnvironmentLabel";
import { Input } from "~/components/primitives/Input";
import { ShortcutKey } from "~/components/primitives/ShortcutKey";

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
          icon={MagnifyingGlassIcon}
          accessory={<ShortcutKey shortcut={{ key: "k", modifiers: ["meta"] }} variant="medium" />}
        />
        <Input
          disabled={disabled}
          variant="medium"
          placeholder="Search"
          icon={MagnifyingGlassIcon}
          accessory={<ShortcutKey shortcut={{ key: "k", modifiers: ["meta"] }} variant="small" />}
        />
        <Input
          disabled={disabled}
          variant="small"
          placeholder="Search"
          icon={MagnifyingGlassIcon}
          accessory={<ShortcutKey shortcut={{ key: "k", modifiers: ["meta"] }} variant="small" />}
        />
        <Input
          disabled={disabled}
          variant="tertiary"
          placeholder="Search"
          icon={MagnifyingGlassIcon}
          accessory={<ShortcutKey shortcut={{ key: "k", modifiers: ["meta"] }} variant="small" />}
        />
      </div>
      <div className="m-8 flex w-64 flex-col gap-4">
        <Input
          disabled={disabled}
          variant="large"
          placeholder="Search"
          icon={<EnvironmentLabel environment={{ type: "DEVELOPMENT" }} />}
          accessory={<ShortcutKey shortcut={{ key: "k", modifiers: ["meta"] }} variant="medium" />}
        />
        <Input
          disabled={disabled}
          variant="medium"
          placeholder="Search"
          icon={<EnvironmentLabel environment={{ type: "DEVELOPMENT" }} />}
          accessory={<ShortcutKey shortcut={{ key: "k", modifiers: ["meta"] }} variant="medium" />}
        />
        <Input
          disabled={disabled}
          variant="small"
          placeholder="Search"
          icon={<EnvironmentLabel environment={{ type: "DEVELOPMENT" }} />}
          accessory={<ShortcutKey shortcut={{ key: "k", modifiers: ["meta"] }} variant="small" />}
        />
        <Input
          disabled={disabled}
          variant="tertiary"
          placeholder="Search"
          icon={<EnvironmentLabel environment={{ type: "DEVELOPMENT" }} />}
          accessory={<ShortcutKey shortcut={{ key: "k", modifiers: ["meta"] }} variant="small" />}
        />
        <Input
          disabled={disabled}
          variant="tertiary"
          placeholder="Search"
          icon={<EnvironmentLabel environment={{ type: "STAGING" }} />}
          accessory={<ShortcutKey shortcut={{ key: "k", modifiers: ["meta"] }} variant="small" />}
        />
        <Input
          disabled={disabled}
          variant="tertiary"
          placeholder="Search"
          icon={<EnvironmentLabel environment={{ type: "PRODUCTION" }} />}
          accessory={<ShortcutKey shortcut={{ key: "k", modifiers: ["meta"] }} variant="small" />}
        />
      </div>
    </div>
  );
}
