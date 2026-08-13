import {
  ArrowTopRightOnSquareIcon,
  CheckIcon,
  ClockIcon,
  CodeBracketIcon,
  PlusIcon,
} from "@heroicons/react/20/solid";
import { DateTime } from "~/components/primitives/DateTime";
import { DetailCell } from "~/components/primitives/DetailCell";
import { LabelValueStack } from "~/components/primitives/LabelValueStack";
import { MiddleTruncate } from "~/components/primitives/MiddleTruncate";
import * as Property from "~/components/primitives/PropertyTable";
import { Story, StoryGrid, StoryPage, StorySection } from "../storybook/StoryKit";

const SAMPLE_DATE = new Date("2026-08-12T09:24:03.000Z");

export default function Story_() {
  return (
    <StoryPage
      title="Cells & key-value"
      description="Detail cells, property tables, label/value stacks and middle truncation."
    >
      <StorySection title="DetailCell">
        <div className="flex max-w-xl flex-col items-start gap-y-4">
          <DetailCell
            leadingIcon={CodeBracketIcon}
            leadingIconClassName="text-text-dimmed"
            label="Learn how to create your own API Integrations"
            variant="base"
            trailingIcon={ArrowTopRightOnSquareIcon}
            trailingIconClassName="text-tertiary group-hover:text-text-bright"
          />
          <DetailCell
            leadingIcon={CodeBracketIcon}
            leadingIconClassName="text-blue-500"
            label="Issue comment created"
            trailingIcon={CheckIcon}
            trailingIconClassName="text-green-500 group-hover:text-green-400"
          />
          <DetailCell
            leadingIcon={ClockIcon}
            leadingIconClassName="text-text-dimmed"
            label={<DateTime date={SAMPLE_DATE} />}
            description="Run #42 complete"
            trailingIcon={PlusIcon}
            trailingIconClassName="text-text-faint group-hover:text-text-bright"
          />
        </div>
      </StorySection>

      <StorySection title="PropertyTable" description="Label-over-value stacks for detail panes.">
        <div className="max-w-md rounded-sm border border-grid-dimmed p-4">
          <Property.Table>
            <Property.Item>
              <Property.Label>Run ID</Property.Label>
              <Property.Value>run_cmsq1zzim1g2y2k8q1az3sfqf</Property.Value>
            </Property.Item>
            <Property.Item>
              <Property.Label>Task</Property.Label>
              <Property.Value>hello-world</Property.Value>
            </Property.Item>
            <Property.Item>
              <Property.Label>Started</Property.Label>
              <Property.Value>
                <DateTime date={SAMPLE_DATE} />
              </Property.Value>
            </Property.Item>
          </Property.Table>
        </div>
      </StorySection>

      <StorySection title="LabelValueStack">
        <StoryGrid min="16rem">
          <Story label="vertical / primary">
            <LabelValueStack label="Queue" value="task/hello-world" variant="primary" />
          </Story>
          <Story label="vertical / secondary">
            <LabelValueStack label="Queue" value="task/hello-world" variant="secondary" />
          </Story>
          <Story label="horizontal">
            <LabelValueStack label="Queue" value="task/hello-world" layout="horizontal" />
          </Story>
          <Story label="With href">
            <LabelValueStack
              label="Docs"
              value="trigger.dev/docs"
              href="https://trigger.dev/docs"
            />
          </Story>
        </StoryGrid>
      </StorySection>

      <StorySection
        title="MiddleTruncate"
        description="Keeps both ends of a long value inside a fixed-width container."
      >
        <div className="flex w-64 flex-col gap-2 rounded-sm border border-grid-dimmed p-3 font-mono text-sm text-text-bright">
          <MiddleTruncate text="run_cmsq1zzim1g2y2k8q1az3sfqf" />
          <MiddleTruncate text="deployment_20260812_a1b2c3d4e5f6g7h8" />
        </div>
      </StorySection>
    </StoryPage>
  );
}
