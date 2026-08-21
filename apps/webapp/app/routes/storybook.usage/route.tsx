import { UsageSparkline } from "~/components/primitives/UsageSparkline";
import { Story, StoryGrid, StoryPage, StorySection } from "../storybook/StoryKit";

/* Fixed start so the tooltips read the same on every render, matching the other
   chart stories. Midnight UTC, so the shape below lines up with the clock. */
const BUCKET_START_MS = Date.UTC(2025, 0, 1);

/* 24 hourly buckets with a believable shape: quiet overnight, busy afternoon. */
const DAY = [0, 0, 1, 0, 2, 4, 9, 14, 22, 31, 28, 35, 41, 38, 52, 61, 48, 39, 27, 18, 12, 7, 3, 1];
const SPARSE = [0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 12, 0, 0, 0, 0, 1, 0, 0, 0, 0];

export default function Story_() {
  return (
    <StoryPage
      componentNames={["UsageSparkline.tsx"]}
      title="Usage sparkline"
      description="The inline 24h bar chart used on prompt and model list rows. Hover for the per-bucket tooltip."
    >
      <StorySection title="Variants">
        <StoryGrid min="16rem">
          <Story label="Default (calls)">
            <UsageSparkline data={DAY} bucketStartMs={BUCKET_START_MS} />
          </Story>
          <Story label="Custom unit + colour">
            <UsageSparkline
              data={DAY.map((v) => v * 1000)}
              bucketStartMs={BUCKET_START_MS}
              color="var(--color-success)"
              unitLabel={{ singular: "token", plural: "tokens" }}
              totalClassName="text-success"
            />
          </Story>
          <Story label="Sparse data">
            <UsageSparkline data={SPARSE} bucketStartMs={BUCKET_START_MS} />
          </Story>
          <Story label="Total override (gauge)">
            <UsageSparkline
              data={DAY}
              bucketStartMs={BUCKET_START_MS}
              total={61}
              formatTotal={(t) => `peak ${t}`}
            />
          </Story>
          <Story label="hideTotal">
            <UsageSparkline data={DAY} bucketStartMs={BUCKET_START_MS} hideTotal />
          </Story>
          <Story label="No data → em-dash">
            <UsageSparkline data={[]} bucketStartMs={BUCKET_START_MS} />
          </Story>
          <Story label="Larger chart">
            <UsageSparkline data={DAY} bucketStartMs={BUCKET_START_MS} chartClassName="h-10 w-48" />
          </Story>
        </StoryGrid>
      </StorySection>
    </StoryPage>
  );
}
