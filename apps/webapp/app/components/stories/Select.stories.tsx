import type { Meta, StoryObj } from "@storybook/react";
import { withDesign } from "storybook-addon-designs";

import { Select } from "../primitives/Select";

const meta: Meta<typeof Select> = {
  title: "Primitives/Select",
  component: Select,
  decorators: [withDesign],
};

export default meta;

type Story = StoryObj<typeof Select>;

export const Basic: Story = {
  args: {
    disabled: false,
  },
  render: (args) => (
    <Select>
      <option>Option One</option>
      <option>Option Two </option>
      <option>Option Three</option>
    </Select>
  ),
};

Basic.parameters = {
  design: {
    type: "figma",
    url: "https://www.figma.com/file/LKQ4FJ4bTnCSjedbRpk931/Sample-File",
  },
};
