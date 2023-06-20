import type { Meta, StoryObj } from "@storybook/react";
import { Switch } from "../primitives/Switch";

const meta: Meta = {
  title: "Primitives/Switch",
};

export default meta;

type Story = StoryObj<typeof Collection>;

export const Switches: Story = {
  render: () => <Collection />,
};

function Collection() {
  return (
    <div className="flex flex-col items-start gap-y-4 p-4">
      <Switch variant="large" />
      <Switch variant="large" disabled />
      <Switch variant="large" label="Toggle me" />
      <Switch variant="large" label="Toggle me" disabled />
      <Switch variant="small" />
      <Switch variant="small" disabled />
      <Switch variant="small" label="Toggle me" />
      <Switch variant="small" label="Toggle me" disabled />
    </div>
  );
}
