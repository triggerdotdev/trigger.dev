import { LightBulbIcon } from "@heroicons/react/20/solid";
import type { Meta, StoryObj } from "@storybook/react";
import { ClipboardIcon } from "lucide-react";
import { withDesign } from "storybook-addon-designs";
import { Header2 } from "../primitives/Headers";
import {
  SimpleTooltip,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../primitives/Tooltip";

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
    <div className="flex flex-col gap-8 p-8">
      <div className="flex gap-4">
        <Header2>Rich Tooltip:</Header2>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger>
              <ClipboardIcon className="h-5 w-5" />
            </TooltipTrigger>
            <TooltipContent className="flex items-center gap-1">
              <LightBulbIcon className="h-4 w-4 text-yellow-400" />
              Copy
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
      <div className="flex gap-4">
        <Header2>Simple Tooltip:</Header2>
        <SimpleTooltip
          button={<ClipboardIcon className="h-5 w-5" />}
          content="Copy"
        />
      </div>
    </div>
  );
}
