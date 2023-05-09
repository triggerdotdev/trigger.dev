import type { Meta, StoryObj } from "@storybook/react";
import { withDesign } from "storybook-addon-designs";

import { DangerButton } from "../primitives/Buttons";

const meta: Meta<typeof DangerButton> = {
  title: "Primitives/DangerButton",
  component: DangerButton,
  decorators: [withDesign],
};

export default meta;

type Story = StoryObj<typeof DangerButton>;

export const Basic: Story = {
  args: {
    children: "Danger Button",
  },

  render: (args) => <DangerButton {...args} />,
};

Basic.parameters = {
  design: {
    type: "figma",
    url: "https://www.figma.com/file/LKQ4FJ4bTnCSjedbRpk931/Sample-File",
  },
};
