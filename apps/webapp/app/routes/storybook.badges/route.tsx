import { Badge } from "~/components/primitives/Badge";
import { BetaBadge, DeprecatedBadge, LegacyBadge, NewBadge } from "~/components/FeatureBadges";
import { Story, StoryGrid, StoryPage, StorySection } from "../storybook/StoryKit";

const VARIANTS = ["default", "extra-small", "small", "outline-rounded", "rounded"] as const;

export default function Story_() {
  return (
    <StoryPage
      title="Badges"
      componentNames={["Badge.tsx", "FeatureBadges.tsx"]}
      description="Every badge variant, coloured status badges, and the feature badges for a feature's lifecycle."
    >
      <StorySection title="Variants" componentName="Badge.tsx">
        <StoryGrid min="12rem">
          {VARIANTS.map((variant) => (
            <Story key={variant} label={variant}>
              <Badge variant={variant}>{variant === "rounded" ? "3" : variant}</Badge>
            </Story>
          ))}
        </StoryGrid>
      </StorySection>

      <StorySection title="In context" description="Counts and labels beside text.">
        <div className="flex flex-wrap items-center gap-4 rounded-sm border border-grid-dimmed p-3">
          <span className="flex items-center gap-2 text-sm text-text-bright">
            Runs <Badge variant="rounded">12</Badge>
          </span>
          <span className="flex items-center gap-2 text-sm text-text-bright">
            Status <Badge variant="extra-small">Live</Badge>
          </span>
          <span className="flex items-center gap-2 text-sm text-text-bright">
            Plan <Badge variant="outline-rounded">Free</Badge>
          </span>
        </div>
      </StorySection>

      <StorySection
        title="Status colours"
        description="An extra-small badge tinted to flag a state: amber needs attention, red needs action. Add system-mono-label so the System themes stay neutral."
      >
        <div className="flex flex-wrap items-center gap-4 rounded-sm border border-grid-dimmed p-3">
          <span className="flex items-center gap-2 text-sm text-text-bright">
            Queue{" "}
            <Badge variant="extra-small" className="system-mono-label text-warning">
              Paused
            </Badge>
          </span>
          <span className="flex items-center gap-2 text-sm text-text-bright">
            Environment{" "}
            <Badge variant="extra-small" className="system-mono-label text-error">
              Action needed
            </Badge>
          </span>
        </div>
      </StorySection>

      <StorySection title="Feature badges" componentName="FeatureBadges.tsx">
        <StoryGrid min="12rem">
          <Story label="NewBadge">
            <NewBadge />
          </Story>
          <Story label="BetaBadge">
            <BetaBadge />
          </Story>
          <Story label="DeprecatedBadge">
            <DeprecatedBadge tooltip="Use version skew protection instead" />
          </Story>
          <Story label="LegacyBadge">
            <LegacyBadge tooltip="Replace with API keys you can revoke one at a time." />
          </Story>
        </StoryGrid>
      </StorySection>
    </StoryPage>
  );
}
