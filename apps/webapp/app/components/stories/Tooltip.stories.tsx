import type { Meta, StoryObj } from "@storybook/react";
import { withDesign } from "storybook-addon-designs";
import {
  SimpleTooltip,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../primitives/Tooltip";
import { ClipboardCopyIcon, ClipboardIcon } from "lucide-react";

const meta: Meta<typeof Tooltips> = {
  title: "Primitives/Tooltips",
  component: Tooltips,
  decorators: [withDesign],
};

export default meta;

type Story = StoryObj<typeof Tooltips>;

export const Basic: Story = {
  args: {
    text: "Action text",
  },

  render: (args) => <Tooltips />,
};

Basic.parameters = {
  design: {
    type: "figma",
    url: "https://www.figma.com/file/LKQ4FJ4bTnCSjedbRpk931/Sample-File",
  },
};

function Tooltips() {
  return (
    <div className="flex gap-8 p-8">
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger>
            <ClipboardIcon className="h-5 w-5" />
          </TooltipTrigger>
          <TooltipContent>Copy</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <SimpleTooltip
        button={<ClipboardCopyIcon className="h-5 w-5" />}
        content="Copy"
      />
    </div>
  );
}
