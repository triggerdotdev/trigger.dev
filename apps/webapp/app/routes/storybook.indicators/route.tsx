import { useState } from "react";
import { AnimatedNumber } from "~/components/primitives/AnimatedNumber";
import { AnimatingArrow, themes as arrowThemes } from "~/components/primitives/AnimatingArrow";
import { Button } from "~/components/primitives/Buttons";
import { PulsingDot } from "~/components/primitives/PulsingDot";
import { StepNumber } from "~/components/primitives/StepNumber";
import { Story, StoryGrid, StoryPage, StorySection } from "../storybook/StoryKit";

export default function Story_() {
  const [number, setNumber] = useState(1234);

  return (
    <StoryPage
      componentNames={[
        "PulsingDot.tsx",
        "StepNumber.tsx",
        "AnimatedNumber.tsx",
        "AnimatingArrow.tsx",
      ]}
      title="Indicators"
      description="Small animated affordances: pulsing dots, step numbers, animated numbers and arrows."
    >
      <StorySection title="PulsingDot">
        <StoryGrid min="13rem">
          <Story label="Default">
            <PulsingDot />
          </Story>
          <Story label="Success">
            <PulsingDot ringClassName="bg-success/50" dotClassName="bg-success" />
          </Story>
          <Story label="Error, larger">
            <PulsingDot className="size-3" ringClassName="bg-error/50" dotClassName="bg-error" />
          </Story>
        </StoryGrid>
      </StorySection>

      <StorySection title="StepNumber" description="The numbered circles in setup flows.">
        <StoryGrid min="13rem">
          <Story label="Default">
            <StepNumber stepNumber="1" title="Create a project" />
          </Story>
          <Story label="Active">
            <StepNumber stepNumber="2" active title="Run the CLI" />
          </Story>
          <Story label="Complete">
            <StepNumber complete title="Install the SDK" />
          </Story>
          <Story label="Spinner">
            <StepNumber displaySpinner title="Waiting for the first run…" />
          </Story>
        </StoryGrid>
      </StorySection>

      <StorySection title="AnimatedNumber" description="Tweens between values.">
        <div className="flex items-center gap-4 rounded-sm border border-grid-dimmed p-3">
          <span className="text-2xl tabular-nums text-text-bright">
            <AnimatedNumber value={number} />
          </span>
          <Button
            variant="secondary/small"
            onClick={() => setNumber(Math.round(Math.random() * 100_000))}
          >
            Randomise
          </Button>
          <span className="text-sm tabular-nums text-text-dimmed">
            2 decimal places: <AnimatedNumber value={number / 1000} decimalPlaces={2} />
          </span>
        </div>
      </StorySection>

      <StorySection
        title="AnimatingArrow"
        description="Hover each cell — the arrow extends on group hover."
      >
        <StoryGrid min="11rem">
          {(["small", "medium", "large", "extra-large"] as const).map((variant) => (
            <Story key={variant} label={`${variant} / dimmed`}>
              <span className="group">
                <AnimatingArrow variant={variant} theme="dimmed" />
              </span>
            </Story>
          ))}
          {(Object.keys(arrowThemes) as Array<keyof typeof arrowThemes>).map((theme) => (
            <Story key={theme} label={`medium / ${theme}`}>
              <span className="group">
                <AnimatingArrow variant="medium" theme={theme} />
              </span>
            </Story>
          ))}
          <Story label="direction left">
            <span className="group">
              <AnimatingArrow direction="left" theme="bright" />
            </span>
          </Story>
          <Story label="direction topRight">
            <span className="group">
              <AnimatingArrow direction="topRight" theme="bright" />
            </span>
          </Story>
        </StoryGrid>
      </StorySection>
    </StoryPage>
  );
}
