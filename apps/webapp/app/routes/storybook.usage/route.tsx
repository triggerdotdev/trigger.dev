import { UsageSparkline } from "~/components/primitives/UsageSparkline";
import { Story, StoryGrid, StoryPage, StorySection } from "../storybook/StoryKit";

/* 24 hourly buckets with a believable shape: quiet overnight, busy afternoon. */
const DAY = [0, 0, 1, 0, 2, 4, 9, 14, 22, 31, 28, 35, 41, 38, 52, 61, 48, 39, 27, 18, 12, 7, 3, 1];
const SPARSE = [0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 12, 0, 0, 0, 0, 1, 0, 0, 0, 0];

export default function Story_() {
  return (
    <StoryPage
      title="Usage sparkline"
      description="The inline 24h bar chart used on prompt and model list rows. Hover for the per-bucket tooltip."
    >
      <StorySection title="Variants">
        <StoryGrid min="16rem">
          <Story label="Default (calls)">
            <UsageSparkline data={DAY} />
          </Story>
          <Story label="Custom unit + colour">
            <UsageSparkline
              data={DAY.map((v) => v * 1000)}
              color="var(--color-success)"
              unitLabel={{ singular: "token", plural: "tokens" }}
              totalClassName="text-success"
            />
          </Story>
          <Story label="Sparse data">
            <UsageSparkline data={SPARSE} />
          </Story>
          <Story label="Total override (gauge)">
            <UsageSparkline data={DAY} total={61} formatTotal={(t) => `peak ${t}`} />
          </Story>
          <Story label="hideTotal">
            <UsageSparkline data={DAY} hideTotal />
          </Story>
          <Story label="No data → em-dash">
            <UsageSparkline data={[]} />
          </Story>
          <Story label="Larger chart">
            <UsageSparkline data={DAY} chartClassName="h-10 w-48" />
          </Story>
        </StoryGrid>
      </StorySection>
    </StoryPage>
  );
}
