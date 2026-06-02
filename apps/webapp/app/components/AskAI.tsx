import { AISparkleIcon } from "~/assets/icons/AISparkleIcon";
import { Button } from "./primitives/Buttons";
import { ShortcutKey } from "./primitives/ShortcutKey";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./primitives/Tooltip";
import { useOptionalAIChat } from "./ai-assistant/AIChatProvider";

export function AskAI() {
  const chat = useOptionalAIChat();

  // The provider is only mounted in the project layout. On account/settings
  // pages there's no assistant, so render nothing. Hide while the drawer is open.
  if (!chat || chat.isOpen) {
    return null;
  }

  return (
    <TooltipProvider disableHoverableContent>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="minimal/small"
            shortcut={{ modifiers: ["mod"], key: "i", enabledOnInputElements: true }}
            hideShortcutKey
            onClick={() => chat.toggle()}
            LeadingIcon={AISparkleIcon}
          >
            Ask AI
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={8} className="flex items-center gap-2 text-xs">
          AI Assistant
          <span className="flex items-center">
            <ShortcutKey shortcut={{ modifiers: ["mod"] }} variant="medium/bright" />
            <ShortcutKey shortcut={{ key: "i" }} variant="medium/bright" />
          </span>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}