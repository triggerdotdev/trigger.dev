import type { Meta, StoryObj } from "@storybook/react";
import { withDesign } from "storybook-addon-designs";
import { Button } from "../Buttons";

const meta: Meta<typeof Button> = {
  title: "Primitives/Button",
  component: Button,
  decorators: [withDesign],
};

export default meta;

type Story = StoryObj<typeof Button>;

export const Basic: Story = {
  args: {
    text: "Action text",
  },

  render: (args) => <Button {...args} />,
};

Basic.parameters = {
  design: {
    type: "figma",
    url: "https://www.figma.com/file/LKQ4FJ4bTnCSjedbRpk931/Sample-File",
  },
};
