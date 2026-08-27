import { useState } from "react";
import { Switch } from "~/components/primitives/Switch";
import { Story, StoryGrid, StoryPage, StorySection } from "../storybook/StoryKit";

const VARIANTS = [
  "large",
  "medium",
  "secondary/small",
  "tertiary/small",
  "minimal/medium",
] as const;

function SwitchSample({
  variant,
  ...props
}: { variant: (typeof VARIANTS)[number] } & Omit<React.ComponentProps<typeof Switch>, "variant">) {
  const [checked, setChecked] = useState(true);
  return <Switch variant={variant} checked={checked} onCheckedChange={setChecked} {...props} />;
}

export default function Story_() {
  return (
    <StoryPage
      title="Switch"
      componentNames={["Switch.tsx"]}
      description="Every variant, with and without labels, in each state."
    >
      <StorySection title="Variants" description="Checked by default; click to toggle.">
        <StoryGrid min="14rem">
          {VARIANTS.map((variant) => (
            <Story key={variant} label={variant}>
              <SwitchSample variant={variant} />
            </Story>
          ))}
        </StoryGrid>
      </StorySection>

      <StorySection title="With labels">
        <StoryGrid min="16rem">
          {VARIANTS.map((variant) => (
            <Story key={variant} label={variant}>
              <SwitchSample variant={variant} label="Toggle me" />
            </Story>
          ))}
          <Story label="labelPosition='right'">
            <SwitchSample variant="large" label="Label on the right" labelPosition="right" />
          </Story>
        </StoryGrid>
      </StorySection>

      <StorySection title="States">
        <StoryGrid min="16rem">
          <Story label="Unchecked">
            <Switch variant="large" checked={false} />
          </Story>
          <Story label="Checked">
            <Switch variant="large" checked />
          </Story>
          <Story label="Disabled, unchecked">
            <Switch variant="large" disabled checked={false} label="Disabled" />
          </Story>
          <Story label="Disabled, checked">
            <Switch variant="large" disabled checked label="Disabled" />
          </Story>
          <Story label="With shortcut (press f)">
            <SwitchSample variant="large" label="Shortcut" shortcut={{ key: "f" }} />
          </Story>
        </StoryGrid>
      </StorySection>
    </StoryPage>
  );
}
