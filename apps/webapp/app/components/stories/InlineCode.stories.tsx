import type { Meta, StoryObj } from "@storybook/react";
import { withDesign } from "storybook-addon-designs";
import { InlineCode } from "../code/InlineCode";
import { Paragraph } from "../primitives/Paragraph";

const meta: Meta<typeof InlineCode> = {
  title: "code/InlineCode",
  component: InlineCode,
  decorators: [withDesign],
};

export default meta;

type Story = StoryObj<typeof InlineCode>;

export const Normal: Story = {
  args: {
    children: `{ id: "my-first-job" }`,
  },
  render: (args) => (
    <Paragraph>
      You should use <InlineCode {...args} /> when you want to achieve this.
    </Paragraph>
  ),
};

Normal.parameters = {
  design: {
    type: "figma",
    url: "https://www.figma.com/file/LKQ4FJ4bTnCSjedbRpk931/Sample-File",
  },
};
