import {
  AgentSpinner,
  ButtonSpinner,
  Spinner,
  SpinnerWhite,
} from "~/components/primitives/Spinner";
import { Story, StoryGrid, StoryPage, StorySection } from "../storybook/StoryKit";

const NAMED = ["blue", "white", "muted", "dark", "inherit"] as const;

export default function Story_() {
  return (
    <StoryPage
      title="Spinners"
      componentNames={["Spinner.tsx"]}
      description="Every colour option and the exported presets. `inherit` takes the surrounding text colour."
    >
      <StorySection title="Named colours" description="Shown on a raised surface.">
        <StoryGrid min="11rem">
          {NAMED.map((color) => (
            <Story key={color} label={color}>
              <span className="flex items-center gap-3 rounded-md bg-background-hover px-3 py-2 text-text-bright">
                <Spinner color={color} />
              </span>
            </Story>
          ))}
        </StoryGrid>
      </StorySection>

      <StorySection
        title="inherit in context"
        description="The same spinner tracking different text colours."
      >
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-white">
            On primary <Spinner color="inherit" />
          </span>
          <span className="flex items-center gap-2 rounded-md bg-secondary px-3 py-2 text-text-bright">
            On secondary <Spinner color="inherit" />
          </span>
          <span className="flex items-center gap-2 rounded-md bg-error px-3 py-2 text-white">
            On error <Spinner color="inherit" />
          </span>
        </div>
      </StorySection>

      <StorySection title="Sizes" description="Sized via className.">
        <StoryGrid min="11rem">
          {["size-3", "size-4", "size-5", "size-8"].map((size) => (
            <Story key={size} label={size}>
              <Spinner color="blue" className={size} />
            </Story>
          ))}
        </StoryGrid>
      </StorySection>

      <StorySection title="Presets and custom">
        <StoryGrid min="11rem">
          <Story label="SpinnerWhite">
            <span className="rounded-md bg-background-hover px-3 py-2">
              <SpinnerWhite />
            </span>
          </Story>
          <Story label="ButtonSpinner">
            <span className="rounded-md bg-primary px-3 py-2">
              <ButtonSpinner />
            </span>
          </Story>
          <Story label="AgentSpinner">
            <AgentSpinner />
          </Story>
          <Story label="Custom colours">
            <Spinner color={{ background: "#EA189E", foreground: "#6532F5" }} />
          </Story>
        </StoryGrid>
      </StorySection>
    </StoryPage>
  );
}
