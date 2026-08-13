import { MoonIcon, SunIcon } from "@heroicons/react/20/solid";
import { useState } from "react";
import { Slider } from "~/components/primitives/Slider";
import { Story, StoryGrid, StoryPage, StorySection } from "../storybook/StoryKit";

function SettingsSlider({
  min = 0,
  max = 100,
  initial = 50,
  withTooltip,
  withMark,
  disabled,
}: {
  min?: number;
  max?: number;
  initial?: number;
  withTooltip?: boolean;
  withMark?: boolean;
  disabled?: boolean;
}) {
  const [value, setValue] = useState(initial);
  return (
    <Slider
      variant="settings"
      className="w-44"
      aria-label="Sample setting"
      min={min}
      max={max}
      step={1}
      value={[value]}
      onValueChange={([v]) => setValue(v)}
      disabled={disabled}
      valueTooltip={withTooltip ? (v) => (v === initial ? "Default" : `${v}%`) : undefined}
      marks={
        withMark
          ? [{ value: initial, label: "Reset to default", onSelect: () => setValue(initial) }]
          : undefined
      }
    />
  );
}

function TertiarySlider({ withIcons }: { withIcons?: boolean }) {
  const [value, setValue] = useState(60);
  return (
    <Slider
      variant="tertiary"
      className="w-44"
      aria-label="Sample setting"
      min={0}
      max={100}
      step={5}
      value={[value]}
      onValueChange={([v]) => setValue(v)}
      LeadingIcon={withIcons ? MoonIcon : undefined}
      TrailingIcon={withIcons ? SunIcon : undefined}
    />
  );
}

export default function Story_() {
  return (
    <StoryPage
      componentNames={["Slider.tsx"]}
      title="Slider"
      description="Radix slider with a quiet settings variant and a hover-boxed tertiary variant."
    >
      <StorySection
        title="Settings variant"
        description="Used on the account page. Drag for the value tooltip; the tick resets to the default."
      >
        <StoryGrid min="16rem">
          <Story label="Plain">
            <SettingsSlider />
          </Story>
          <Story label="Value tooltip (hover / drag)">
            <SettingsSlider withTooltip />
          </Story>
          <Story label="Default mark, click to reset">
            <SettingsSlider withTooltip withMark initial={30} />
          </Story>
          <Story label="Floored range (min 15)">
            <SettingsSlider min={15} initial={30} withTooltip withMark />
          </Story>
          <Story label="Disabled">
            <SettingsSlider disabled />
          </Story>
        </StoryGrid>
      </StorySection>

      <StorySection title="Tertiary variant" description="Hover surfaces the range fill.">
        <StoryGrid min="16rem">
          <Story label="Plain">
            <TertiarySlider />
          </Story>
          <Story label="Leading & trailing icons">
            <TertiarySlider withIcons />
          </Story>
        </StoryGrid>
      </StorySection>
    </StoryPage>
  );
}
