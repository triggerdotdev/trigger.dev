import { MoonIcon, SunIcon } from "@heroicons/react/20/solid";
import { useState } from "react";
import SegmentedControl from "~/components/primitives/SegmentedControl";
import { Story, StoryGrid, StoryPage, StorySection } from "../storybook/StoryKit";

const VARIANTS = [
  "primary/small",
  "primary/medium",
  "secondary/small",
  "secondary/medium",
] as const;

const OPTIONS = [
  { label: "Label 1", value: "label1" },
  { label: "Label 2", value: "label2" },
];

const THREE_OPTIONS = [
  { label: "All", value: "all" },
  { label: "Standard", value: "standard" },
  { label: "Scheduled", value: "scheduled" },
];

/** Controlled so the selection indicator animates when clicked. */
function Sample({
  variant,
  options = OPTIONS,
  fullWidth,
  name,
}: {
  variant: (typeof VARIANTS)[number];
  options?: { label: React.ReactNode; value: string }[];
  fullWidth?: boolean;
  name: string;
}) {
  const [value, setValue] = useState(options[0].value);
  return (
    <SegmentedControl
      name={name}
      value={value}
      options={options}
      variant={variant}
      fullWidth={fullWidth}
      onChange={setValue}
    />
  );
}

export default function Story_() {
  return (
    <StoryPage
      title="Segmented control"
      componentNames={["SegmentedControl.tsx"]}
      description="All four variants, with two and three options, icon labels and full width."
    >
      <StorySection title="Variants">
        <StoryGrid min="18rem">
          {VARIANTS.map((variant) => (
            <Story key={variant} label={variant}>
              <Sample variant={variant} name={`variant-${variant}`} />
            </Story>
          ))}
        </StoryGrid>
      </StorySection>

      <StorySection title="Three options" description="As used by the task type filter.">
        <StoryGrid min="20rem">
          {VARIANTS.map((variant) => (
            <Story key={variant} label={variant}>
              <Sample variant={variant} options={THREE_OPTIONS} name={`three-${variant}`} />
            </Story>
          ))}
        </StoryGrid>
      </StorySection>

      <StorySection title="Icon labels" description="`label` takes any node, not just a string.">
        <StoryGrid min="18rem">
          <Story label="secondary/small">
            <Sample
              variant="secondary/small"
              name="icons-small"
              options={[
                { label: <SunIcon className="size-4" />, value: "light" },
                { label: <MoonIcon className="size-4" />, value: "dark" },
              ]}
            />
          </Story>
          <Story label="Icon + text">
            <Sample
              variant="secondary/medium"
              name="icons-text"
              options={[
                {
                  label: (
                    <span className="flex items-center gap-1.5">
                      <SunIcon className="size-4" /> Light
                    </span>
                  ),
                  value: "light",
                },
                {
                  label: (
                    <span className="flex items-center gap-1.5">
                      <MoonIcon className="size-4" /> Dark
                    </span>
                  ),
                  value: "dark",
                },
              ]}
            />
          </Story>
        </StoryGrid>
      </StorySection>

      <StorySection title="fullWidth">
        <div className="max-w-md">
          <Sample variant="secondary/medium" name="full" options={THREE_OPTIONS} fullWidth />
        </div>
      </StorySection>
    </StoryPage>
  );
}
