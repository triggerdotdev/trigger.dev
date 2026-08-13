import { MagnifyingGlassIcon } from "@heroicons/react/20/solid";
import { useState } from "react";
import { Input } from "~/components/primitives/Input";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSeparator,
  InputOTPSlot,
} from "~/components/primitives/InputOTP";
import { SearchInput } from "~/components/primitives/SearchInput";
import { ShortcutKey } from "~/components/primitives/ShortcutKey";
import { Story, StoryGrid, StoryPage, StorySection } from "../storybook/StoryKit";

export default function Story_() {
  return (
    <StoryPage
      componentNames={["Input.tsx", "SearchInput.tsx", "InputOTP.tsx"]}
      title="Input fields"
      description="Text inputs, search inputs and one-time codes."
    >
      <StorySection title="Input" description="All variants, enabled and disabled.">
        <div className="flex gap-16">
          <InputFieldSet />
          <InputFieldSet disabled />
        </div>
      </StorySection>

      <StorySection
        title="SearchInput"
        description="Debounced search field; in controlled mode here so it doesn't write URL params."
      >
        <StoryGrid min="18rem">
          <Story label="Controlled">
            <ControlledSearch />
          </Story>
        </StoryGrid>
      </StorySection>

      <StorySection title="InputOTP" description="One-time code entry, used for MFA.">
        <StoryGrid min="20rem">
          <Story label="default">
            <InputOTP maxLength={6} variant="default">
              <InputOTPGroup>
                {[0, 1, 2].map((i) => (
                  <InputOTPSlot key={i} index={i} variant="default" />
                ))}
              </InputOTPGroup>
              <InputOTPSeparator />
              <InputOTPGroup>
                {[3, 4, 5].map((i) => (
                  <InputOTPSlot key={i} index={i} variant="default" />
                ))}
              </InputOTPGroup>
            </InputOTP>
          </Story>
          <Story label="large">
            <InputOTP maxLength={6} variant="large">
              <InputOTPGroup variant="large">
                {[0, 1, 2, 3, 4, 5].map((i) => (
                  <InputOTPSlot key={i} index={i} variant="large" />
                ))}
              </InputOTPGroup>
            </InputOTP>
          </Story>
          <Story label="minimal">
            <InputOTP maxLength={6} variant="minimal">
              <InputOTPGroup variant="minimal">
                {[0, 1, 2, 3, 4, 5].map((i) => (
                  <InputOTPSlot key={i} index={i} variant="minimal" />
                ))}
              </InputOTPGroup>
            </InputOTP>
          </Story>
        </StoryGrid>
      </StorySection>
    </StoryPage>
  );
}

function ControlledSearch() {
  const [value, setValue] = useState("");
  return <SearchInput placeholder="Search runs…" value={value} onValueChange={setValue} />;
}

function InputFieldSet({ disabled }: { disabled?: boolean }) {
  return (
    <div>
      <div className="flex w-64 flex-col gap-4">
        <Input disabled={disabled} variant="large" placeholder="Name" type="text" />
        <Input disabled={disabled} variant="medium" placeholder="Name" type="text" />
        <Input disabled={disabled} variant="small" placeholder="Name" type="text" />
        <Input disabled={disabled} variant="tertiary" placeholder="Name" type="text" />
        <Input disabled={disabled} variant="secondary-small" placeholder="Name" type="text" />
        <Input disabled={disabled} variant="outline/large" placeholder="Name" type="text" />
        <Input disabled={disabled} variant="outline/medium" placeholder="Name" type="text" />
        <Input disabled={disabled} variant="outline/small" placeholder="Name" type="text" />
      </div>
      <div className="mt-8 flex w-64 flex-col gap-4">
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
    </div>
  );
}
