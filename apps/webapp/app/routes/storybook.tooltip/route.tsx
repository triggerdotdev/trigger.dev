import { LightBulbIcon } from "@heroicons/react/20/solid";
import { ClipboardIcon } from "lucide-react";
import { MainCenteredContainer } from "~/components/layout/AppLayout";
import { Header2 } from "~/components/primitives/Headers";
import {
  SimpleTooltip,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "~/components/primitives/Tooltip";

export default function Story() {
  return (
    <MainCenteredContainer className="flex flex-col gap-4">
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
        <SimpleTooltip button={<ClipboardIcon className="h-5 w-5" />} content="Copy" />
      </div>
    </MainCenteredContainer>
  );
}
