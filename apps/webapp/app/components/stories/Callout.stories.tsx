import type { Meta, StoryObj } from "@storybook/react";
import { withDesign } from "storybook-addon-designs";
import { useState } from "react";
import { Button } from "../primitives/Buttons";
import { Callout } from "../primitives/Callout";
import { EnvelopeIcon } from "@heroicons/react/24/solid";

const meta: Meta = {
  title: "Primitives/Callout",
  decorators: [withDesign],
};

export default meta;

type Story = StoryObj<typeof CalloutsSet>;

export const Callouts: Story = {
  render: () => <CalloutsSet />,
};

function CalloutsSet() {
  return (
    <div className="flex flex-col items-start gap-y-4 p-4">
      <Callout variant="info">This is an info callout</Callout>
      <Callout variant="warning">This is a warning callout</Callout>
      <Callout variant="error">This is an error callout</Callout>
      <Callout variant="idea">This is an idea callout</Callout>
      <Callout
        variant="idea"
        icon={<EnvelopeIcon className="h-5 w-5 text-green-400" />}
      >
        This has a custom icon
      </Callout>
    </div>
  );
}
