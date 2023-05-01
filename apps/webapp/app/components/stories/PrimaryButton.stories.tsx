import type { Meta, StoryObj } from "@storybook/react";
import { withDesign } from "storybook-addon-designs";

import { PrimaryButton } from "../primitives/Buttons";

const meta: Meta<typeof PrimaryButton> = {
  title: "Primitives/PrimaryButton",
  component: PrimaryButton,
  decorators: [withDesign],
};

export default meta;

type Story = StoryObj<typeof PrimaryButton>;

export const Basic: Story = {
  args: {
    children: "Primary Button",
  },
  render: (args) => <PrimaryButton {...args} />,
};

Basic.parameters = {
  design: {
    type: "figma",
    url: "https://www.figma.com/file/LKQ4FJ4bTnCSjedbRpk931/Sample-File",
  },
};
