import type { Meta, StoryObj } from "@storybook/react";
import { withDesign } from "storybook-addon-designs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../primitives/Dialog";

const meta: Meta<typeof Dialog> = {
  title: "Primitives/Dialog",
  // @ts-ignore
  component: Dialog,
  decorators: [withDesign],
};

export default meta;

type Story = StoryObj<typeof Dialog>;

export const Basic: Story = {
  args: {
    // @ts-ignore
    appear: true,
    show: true,
    title: "Dialog Title",
  },
  render: (args) => (
    <Dialog {...args}>
      <DialogTrigger>Open</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Are you sure absolutely sure?</DialogTitle>
          <DialogDescription>
            This action cannot be undone. This will permanently delete your
            account and remove your data from our servers.
          </DialogDescription>
        </DialogHeader>
      </DialogContent>
    </Dialog>
  ),
};

Basic.parameters = {
  design: {
    type: "figma",
    url: "https://www.figma.com/file/LKQ4FJ4bTnCSjedbRpk931/Sample-File",
  },
};
