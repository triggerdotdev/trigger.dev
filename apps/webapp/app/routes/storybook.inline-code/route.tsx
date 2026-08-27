import { InlineCode } from "~/components/code/InlineCode";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Story, StoryGrid, StoryPage, StorySection } from "../storybook/StoryKit";

const VARIANTS = ["extra-extra-small", "extra-small", "small", "base"] as const;

export default function Story_() {
  return (
    <StoryPage
      title="Inline code"
      componentNames={["InlineCode.tsx"]}
      description="Monospaced inline snippets at every size."
    >
      <StorySection title="Variants">
        <StoryGrid min="14rem">
          {VARIANTS.map((variant) => (
            <Story key={variant} label={variant}>
              <InlineCode variant={variant}>id: my-first-job</InlineCode>
            </Story>
          ))}
        </StoryGrid>
      </StorySection>

      <StorySection title="In prose" description="Sized to sit inside body text.">
        <div className="max-w-xl space-y-3 rounded-sm border border-grid-dimmed p-3">
          <Paragraph>
            You should use <InlineCode>id: my-first-job</InlineCode> when you want to achieve this.
          </Paragraph>
          <Paragraph variant="small">
            Small text with <InlineCode variant="extra-small">trigger.config.ts</InlineCode> inline.
          </Paragraph>
          <Paragraph variant="extra-small">
            Extra small text with <InlineCode variant="extra-extra-small">--env dev</InlineCode>{" "}
            inline.
          </Paragraph>
        </div>
      </StorySection>
    </StoryPage>
  );
}
