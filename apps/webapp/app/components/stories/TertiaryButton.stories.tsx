import type { Meta, StoryObj } from "@storybook/react";
import { withDesign } from "storybook-addon-designs";

import { TertiaryButton } from "../primitives/Buttons";

const meta: Meta<typeof TertiaryButton> = {
  title: "Primitives/TertiaryButton",
  component: TertiaryButton,
  decorators: [withDesign],
};

export default meta;

type Story = StoryObj<typeof TertiaryButton>;

export const Basic: Story = {
  args: {
    children: "Tertiary Button",
  },
  render: (args) => <TertiaryButton {...args} />,
};

Basic.parameters = {
  design: {
    type: "figma",
    url: "https://www.figma.com/file/LKQ4FJ4bTnCSjedbRpk931/Sample-File",
  },
};
