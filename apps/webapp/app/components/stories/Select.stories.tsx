import type { Meta, StoryObj } from "@storybook/react";
import { withDesign } from "storybook-addon-designs";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../primitives/Select";
import { Button } from "../primitives/Buttons";

const meta: Meta<typeof Select> = {
  title: "Primitives/Select",
  component: Select,
  decorators: [withDesign],
  tags: ["autodocs"],
};

export default meta;

type Story = StoryObj<typeof Select>;

export const Basic: Story = {
  args: {
    disabled: false,
  },
  render: (args) => (
    <form method="GET" action="" className="flex flex-col gap-2">
      <Select name="colorScheme" defaultValue="dark">
        <SelectTrigger className="w-[180px]">
          <SelectValue placeholder="Theme" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="light">Light</SelectItem>
          <SelectItem value="dark">Dark</SelectItem>
          <SelectItem value="system">System</SelectItem>
        </SelectContent>
      </Select>
      <Button type="submit" variant="primary/medium">
        Submit
      </Button>
    </form>
  ),
};

Basic.parameters = {
  design: {
    type: "figma",
    url: "https://www.figma.com/file/LKQ4FJ4bTnCSjedbRpk931/Sample-File",
  },
};
