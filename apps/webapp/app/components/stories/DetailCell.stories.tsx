import type { Meta, StoryObj } from "@storybook/react";
import { DetailCell } from "../primitives/DetailCell";
import { ClockIcon, CodeBracketIcon } from "@heroicons/react/24/outline";
import { DateTime, DateTimeAccurate } from "../primitives/DateTime";

const meta: Meta = {
  title: "Primitives/DetailCells",
};

export default meta;

type Story = StoryObj<typeof Examples>;

export const Basic: Story = {
  render: () => <Examples />,
};

function Examples() {
  return (
    <div className="flex max-w-xl flex-col items-start gap-y-8 p-8">
      <DetailCell
        leadingIcon="integration"
        leadingIconClassName="text-dimmed"
        label="Learn how to create your own API Integrations"
        variant="base"
        trailingIcon="external-link"
        trailingIconClassName="text-slate-700 group-hover:text-bright"
      />
      <DetailCell
        leadingIcon={CodeBracketIcon}
        leadingIconClassName="text-blue-500"
        label="Issue comment created"
        trailingIcon="check"
        trailingIconClassName="text-green-500 group-hover:text-green-400"
      />
      <DetailCell
        leadingIcon={ClockIcon}
        leadingIconClassName="text-slate-400"
        label={<DateTime date={new Date()} />}
        description="Run #42 complete"
        trailingIcon="plus"
        trailingIconClassName="text-slate-500 group-hover:text-bright"
      />
    </div>
  );
}
