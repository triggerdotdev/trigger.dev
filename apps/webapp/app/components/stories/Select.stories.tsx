import type { Meta, StoryObj } from "@storybook/react";
import { withDesign } from "storybook-addon-designs";

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "../primitives/Select";
import { Header1 } from "../primitives/Headers";
import { SelectSeparator } from "@radix-ui/react-select";

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
    <div className="flex h-screen flex-col gap-4 bg-slate-1000">
      <Header1>Select</Header1>
      <SelectGroup>
        <Select name="colorScheme" defaultValue="dark">
          <SelectTrigger className="w-fit">
            <SelectValue placeholder="Theme" />
          </SelectTrigger>
          <SelectContent>
            <SelectLabel>Color Scheme</SelectLabel>
            <SelectItem value="light">Light</SelectItem>
            <SelectItem value="dark">Dark</SelectItem>
            <SelectItem value="system">System</SelectItem>
            <SelectLabel>Other themes</SelectLabel>
            <SelectItem value="sunset">Sunset</SelectItem>
            <SelectItem value="midnight">Midnight</SelectItem>
            <SelectSeparator />
            <SelectItem value="lunar">Lunar</SelectItem>
          </SelectContent>
        </Select>
      </SelectGroup>
    </div>
  ),
};

Basic.parameters = {
  design: {
    type: "figma",
    url: "https://www.figma.com/file/jBqUJJ2d4lU6aSeKIIOBMY/Trigger.dev?type=design&node-id=1759%3A2827&t=lP20lNML1kp3VPMQ-1",
  },
};
