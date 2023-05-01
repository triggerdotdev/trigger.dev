import type { Meta, StoryObj } from "@storybook/react";
import { withDesign } from "storybook-addon-designs";

import { SecondaryButton } from "../primitives/Buttons";

const meta: Meta<typeof SecondaryButton> = {
  title: "Primitives/SecondaryButton",
  component: SecondaryButton,
  decorators: [withDesign],
};

export default meta;

type Story = StoryObj<typeof SecondaryButton>;

export const Basic: Story = {
  args: {
    children: "Secondary Button",
  },
  render: (args) => <SecondaryButton {...args} />,
};

Basic.parameters = {
  design: {
    type: "figma",
    url: "https://www.figma.com/file/LKQ4FJ4bTnCSjedbRpk931/Sample-File",
  },
};
