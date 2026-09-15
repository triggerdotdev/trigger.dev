import { Badge } from "~/components/primitives/Badge";
import { NewBadge } from "~/components/FeatureBadges";
import { Story, StoryGrid, StoryPage, StorySection } from "../storybook/StoryKit";

const VARIANTS = ["default", "extra-small", "small", "outline-rounded", "rounded"] as const;

export default function Story_() {
  return (
    <StoryPage
      title="Badges"
      componentNames={["Badge.tsx", "FeatureBadges.tsx"]}
      description="Every badge variant, plus the feature badges used in the side menu."
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

      <StorySection title="Feature badges" componentName="FeatureBadges.tsx">
        <StoryGrid min="12rem">
          <Story label="NewBadge">
            <NewBadge />
          </Story>
        </StoryGrid>
      </StorySection>
    </StoryPage>
  );
}
