import type { Meta, StoryObj } from "@storybook/react";
import { withDesign } from "storybook-addon-designs";

import { StyledDialog } from "../Dialog";

const meta: Meta<typeof StyledDialog> = {
  title: "Primitives/Dialog",
  // @ts-ignore
  component: StyledDialog.Dialog,
  decorators: [withDesign],
};

export default meta;

type Story = StoryObj<typeof StyledDialog>;

export const Basic: Story = {
  args: {
    // @ts-ignore
    appear: true,
    show: true,
    title: "Dialog Title",
  },
  render: (args) => (
    <StyledDialog.Dialog onClose={() => {}} {...args}>
      <StyledDialog.Panel>
        {/* @ts-ignore */}
        <StyledDialog.Title>{args.title}</StyledDialog.Title>
        Here is some Dialog Content
      </StyledDialog.Panel>
    </StyledDialog.Dialog>
  ),
};

Basic.parameters = {
  design: {
    type: "figma",
    url: "https://www.figma.com/file/LKQ4FJ4bTnCSjedbRpk931/Sample-File",
  },
};
