import { useState } from "react";
import { DateField } from "~/components/primitives/DateField";
import { DateTimePicker } from "~/components/primitives/DateTimePicker";
import { DurationPicker } from "~/components/primitives/DurationPicker";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Story, StoryGrid, StoryPage, StorySection } from "../storybook/StoryKit";

export default function Story_() {
  return (
    <StoryPage
      componentNames={["DateField.tsx", "DateTimePicker.tsx", "DurationPicker.tsx"]}
      title="Date fields"
      description="Segmented date entry, the combined date-time picker and the duration picker."
    >
      <StorySection title='DateField — variant="small" (default)'>
        <div className="flex flex-col gap-4">
          <DateField label="From (UTC)" granularity="second" showNowButton showClearButton />
          <DateField
            label="From (UTC)"
            defaultValue={new Date("2026-08-12T09:24:03.000Z")}
            granularity="second"
            showNowButton
            showClearButton
          />
        </div>
      </StorySection>

      <StorySection title="DateField — medium">
        <div className="flex flex-col gap-4">
          <DateField
            label="From (UTC)"
            granularity="second"
            showNowButton
            showClearButton
            variant="medium"
          />
          <DateField
            label="From (UTC)"
            defaultValue={new Date("2026-08-12T09:24:03.000Z")}
            granularity="second"
            showNowButton
            showClearButton
            variant="medium"
          />
        </div>
      </StorySection>

      <StorySection title="DateTimePicker">
        <StoryGrid min="20rem">
          <Story label="Controlled">
            <ControlledDateTimePicker />
          </Story>
        </StoryGrid>
      </StorySection>

      <StorySection title="DurationPicker">
        <StoryGrid min="20rem">
          <Story label="small (default), starts at 90s">
            <ControlledDurationPicker />
          </Story>
          <Story label="medium">
            <ControlledDurationPicker variant="medium" />
          </Story>
        </StoryGrid>
      </StorySection>
    </StoryPage>
  );
}

function ControlledDateTimePicker() {
  const [value, setValue] = useState<Date | undefined>(new Date("2026-08-12T09:24:00.000Z"));
  return (
    <div className="flex flex-col gap-2">
      <DateTimePicker
        label="Run at"
        value={value}
        onChange={setValue}
        showNowButton
        showClearButton
      />
      <Paragraph variant="extra-small" className="text-text-dimmed">
        {value ? value.toISOString() : "No date selected"}
      </Paragraph>
    </div>
  );
}

function ControlledDurationPicker({ variant }: { variant?: "small" | "medium" }) {
  const [seconds, setSeconds] = useState(90);
  return (
    <div className="flex flex-col gap-2">
      <DurationPicker value={seconds} onChange={setSeconds} variant={variant} />
      <Paragraph variant="extra-small" className="text-text-dimmed">
        {seconds} seconds
      </Paragraph>
    </div>
  );
}
