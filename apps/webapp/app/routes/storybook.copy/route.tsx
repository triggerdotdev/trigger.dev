import { CopyButton } from "~/components/primitives/CopyButton";
import { CopyTextLink } from "~/components/primitives/CopyTextLink";
import { CopyableText } from "~/components/primitives/CopyableText";
import { TruncatedCopyableValue } from "~/components/primitives/TruncatedCopyableValue";
import { Story, StoryGrid, StoryPage, StorySection } from "../storybook/StoryKit";

const RUN_ID = "run_cmsq1zzim1g2y2k8q1az3sfqf";

export default function Story_() {
  return (
    <StoryPage
      componentNames={[
        "CopyButton.tsx",
        "CopyableText.tsx",
        "TruncatedCopyableValue.tsx",
        "CopyTextLink.tsx",
      ]}
      title="Copy & clipboard"
      description="The copy affordances: buttons, links, inline text and truncated IDs. Click any of them."
    >
      <StorySection title="CopyButton — button variant" description="Sizes with a label child.">
        <StoryGrid min="13rem">
          <Story label="extra-small">
            <CopyButton value={RUN_ID} variant="button" size="extra-small">
              Copy
            </CopyButton>
          </Story>
          <Story label="small">
            <CopyButton value={RUN_ID} variant="button" size="small">
              Copy
            </CopyButton>
          </Story>
          <Story label="medium">
            <CopyButton value={RUN_ID} variant="button" size="medium">
              Copy
            </CopyButton>
          </Story>
        </StoryGrid>
      </StorySection>

      <StorySection title="CopyButton — icon variant">
        <StoryGrid min="13rem">
          <Story label="extra-small">
            <CopyButton value={RUN_ID} variant="icon" size="extra-small" />
          </Story>
          <Story label="small">
            <CopyButton value={RUN_ID} variant="icon" size="small" />
          </Story>
          <Story label="medium">
            <CopyButton value={RUN_ID} variant="icon" size="medium" />
          </Story>
        </StoryGrid>
      </StorySection>

      <StorySection title="CopyableText" description="Inline text that copies on click.">
        <StoryGrid min="16rem">
          <Story label="Default (icon on hover)">
            <CopyableText value={RUN_ID} className="font-mono text-xs" />
          </Story>
          <Story label="icon-right">
            <CopyableText value="hello-world" variant="icon-right" className="text-sm" />
          </Story>
          <Story label="Copy a different value">
            <CopyableText value="Display text" copyValue={RUN_ID} className="text-sm" />
          </Story>
          <Story label="text-below">
            <CopyableText value="hello-world" variant="text-below" className="text-sm" />
          </Story>
        </StoryGrid>
      </StorySection>

      <StorySection
        title="TruncatedCopyableValue"
        description="Shows the tail of a long ID; the tooltip carries the whole value."
      >
        <StoryGrid min="16rem">
          <Story label="Default (last 8)">
            <TruncatedCopyableValue value={RUN_ID} />
          </Story>
          <Story label="length={12}">
            <TruncatedCopyableValue value={RUN_ID} length={12} />
          </Story>
        </StoryGrid>
      </StorySection>

      <StorySection title="CopyTextLink">
        <StoryGrid min="16rem">
          <Story label="Default">
            <CopyTextLink value={RUN_ID} />
          </Story>
        </StoryGrid>
      </StorySection>
    </StoryPage>
  );
}
