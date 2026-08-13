import { Paragraph } from "~/components/primitives/Paragraph";
import { cn } from "~/utils/cn";
import { StoryGrid, StoryPage, StorySection } from "../storybook/StoryKit";

/* Semantic tokens from tailwind.css. Swatches read the live CSS variables, so
   flipping the storybook theme switcher shows each theme's palette in place. */

const BACKGROUND_TOKENS = [
  "--color-background-deep",
  "--color-background-dimmed",
  "--color-background-bright",
  "--color-background-hover",
  "--color-background-raised",
  "--color-secondary",
  "--color-tertiary",
  "--color-surface-control",
  "--color-surface-control-hover",
  "--color-surface-control-active",
  "--color-input-bg",
];

const LINE_TOKENS = [
  "--color-grid-dimmed",
  "--color-grid-bright",
  "--color-border-bright",
  "--color-border-brighter",
  "--color-border-brightest",
];

const TEXT_TOKENS = [
  "--color-text-bright",
  "--color-text-dimmed",
  "--color-text-faint",
  "--color-text-link",
];

const STATUS_TOKENS = ["--color-success", "--color-warning", "--color-error", "--color-pending"];

const ENVIRONMENT_TOKENS = ["--color-dev", "--color-preview", "--color-prod"];

const CHARCOAL_SCALE = [
  100, 200, 300, 400, 500, 550, 600, 650, 700, 750, 775, 800, 850, 900, 950, 1000,
].map((stop) => `--color-charcoal-${stop}`);

function Swatch({ token, tall }: { token: string; tall?: boolean }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div
        className={cn("rounded-sm border border-grid-bright", tall ? "h-16" : "h-10")}
        style={{ backgroundColor: `var(${token})` }}
      />
      <Paragraph variant="extra-extra-small" className="font-mono text-text-dimmed">
        {token.replace("--color-", "")}
      </Paragraph>
    </div>
  );
}

export default function Story_() {
  return (
    <StoryPage
      componentNames={["tailwind.css"]}
      title="Theme tokens"
      description="The semantic color layer. Use the theme switcher above to compare every theme's values live."
    >
      <StorySection title="Backgrounds & surfaces">
        <StoryGrid min="10rem">
          {BACKGROUND_TOKENS.map((token) => (
            <Swatch key={token} token={token} tall />
          ))}
        </StoryGrid>
      </StorySection>

      <StorySection title="Grid lines & borders">
        <StoryGrid min="10rem">
          {LINE_TOKENS.map((token) => (
            <Swatch key={token} token={token} />
          ))}
        </StoryGrid>
      </StorySection>

      <StorySection title="Text" description="Rendered as text on the page background.">
        <div className="flex flex-col gap-2 rounded-sm border border-grid-dimmed p-4">
          {TEXT_TOKENS.map((token) => (
            <div key={token} className="flex items-baseline gap-4">
              <span className="text-base" style={{ color: `var(${token})` }}>
                The quick brown fox jumps over the lazy dog
              </span>
              <Paragraph variant="extra-extra-small" className="font-mono text-text-dimmed">
                {token.replace("--color-", "")}
              </Paragraph>
            </div>
          ))}
        </div>
      </StorySection>

      <StorySection title="Status">
        <StoryGrid min="10rem">
          {STATUS_TOKENS.map((token) => (
            <Swatch key={token} token={token} />
          ))}
        </StoryGrid>
      </StorySection>

      <StorySection title="Environments">
        <StoryGrid min="10rem">
          {ENVIRONMENT_TOKENS.map((token) => (
            <Swatch key={token} token={token} />
          ))}
        </StoryGrid>
      </StorySection>

      <StorySection title="Charcoal scale" description="The raw neutral ramp behind the tokens.">
        <StoryGrid min="7rem">
          {CHARCOAL_SCALE.map((token) => (
            <Swatch key={token} token={token} />
          ))}
        </StoryGrid>
      </StorySection>
    </StoryPage>
  );
}
