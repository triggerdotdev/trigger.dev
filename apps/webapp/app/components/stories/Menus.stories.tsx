import type { Meta, StoryObj } from "@storybook/react";
import { withDesign } from "storybook-addon-designs";
import { Fragment, useState } from "react";

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "../primitives/Select";
import { Header1, Header2 } from "../primitives/Headers";
import { SelectSeparator } from "@radix-ui/react-select";
import {
  Popover,
  PopoverArrowTrigger,
  PopoverContent,
  PopoverMenuItem,
  PopoverSectionHeader,
} from "../primitives/Popover";

const meta: Meta<typeof SelectMenu> = {
  title: "Primitives/Menus",
  component: SelectMenu,
  decorators: [withDesign],
  tags: ["autodocs"],
};

export default meta;

type Story = StoryObj<typeof SelectMenu>;

export const Selects: Story = {
  render: (args) => <SelectMenu />,
};

export const Popovers: Story = {
  render: (args) => <PopoverMenu />,
};

function SelectMenu() {
  return (
    <div className="flex flex-col">
      <Header1 className="mb-4">Variants</Header1>
      <Header2 className="my-4 font-mono">size=small width=content</Header2>
      <SelectGroup>
        <Select name="colorScheme" defaultValue="dark">
          <SelectTrigger>
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
      <Header2 className="my-4 font-mono">size=small width=full</Header2>
      <SelectGroup>
        <Select name="colorScheme" defaultValue="dark">
          <SelectTrigger width="full">
            <SelectValue placeholder="Theme" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="light">Light</SelectItem>
            <SelectItem value="dark">Dark</SelectItem>
            <SelectItem value="system">System</SelectItem>
            <SelectItem value="sunset">Sunset</SelectItem>
            <SelectItem value="midnight">Midnight</SelectItem>
            <SelectSeparator />
            <SelectItem value="lunar">Lunar</SelectItem>
          </SelectContent>
        </Select>
      </SelectGroup>
      <Header2 className="my-4 font-mono">size=medium width=content</Header2>
      <SelectGroup>
        <Select name="colorScheme" defaultValue="dark">
          <SelectTrigger size="medium">
            <SelectValue placeholder="Theme" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="light">Light</SelectItem>
            <SelectItem value="dark">Dark</SelectItem>
            <SelectItem value="system">System</SelectItem>
            <SelectItem value="sunset">Sunset</SelectItem>
            <SelectItem value="midnight">Midnight</SelectItem>
            <SelectSeparator />
            <SelectItem value="lunar">Lunar</SelectItem>
          </SelectContent>
        </Select>
      </SelectGroup>
      <Header2 className="my-4 font-mono">size=medium width=full</Header2>
      <SelectGroup>
        <Select name="colorScheme" defaultValue="dark">
          <SelectTrigger size="medium" width="full">
            <SelectValue placeholder="Theme" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="light">Light</SelectItem>
            <SelectItem value="dark">Dark</SelectItem>
            <SelectItem value="system">System</SelectItem>
            <SelectItem value="sunset">Sunset</SelectItem>
            <SelectItem value="midnight">Midnight</SelectItem>
            <SelectSeparator />
            <SelectItem value="lunar">Lunar</SelectItem>
          </SelectContent>
        </Select>
      </SelectGroup>
    </div>
  );
}

function PopoverMenu() {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <Popover onOpenChange={(open) => setIsOpen(open)}>
      <PopoverArrowTrigger isOpen={isOpen}>My Blog</PopoverArrowTrigger>
      <PopoverContent
        className="min-w-[20rem] overflow-y-auto p-0 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-slate-700"
        align="start"
      >
        <Fragment>
          <PopoverSectionHeader title="Acme Ltd." />

          <div className="flex flex-col gap-1 p-1">
            <PopoverMenuItem to="#" title="My Blog" icon="folder" />
            <PopoverMenuItem to="#" title="New Project" isSelected={false} icon="plus" />
          </div>
        </Fragment>
        <div className="border-t border-slate-800 p-1">
          <PopoverMenuItem to="#" title="New Organization" isSelected={false} icon="plus" />
        </div>
      </PopoverContent>
    </Popover>
  );
}
