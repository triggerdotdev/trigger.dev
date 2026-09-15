import { useState } from "react";
import {
  Popover,
  PopoverContent,
  PopoverMenuItem,
  PopoverVerticalEllipseTrigger,
} from "~/components/primitives/Popover";
import { cn } from "~/utils/cn";
import type { AgentBlockTool } from "./agent-block-tools";

// Shared by the inline hover-reveal trigger and the always-visible fullscreen header trigger.
export function AgentBlockToolsMenu({
  tools,
  revealOnHover = true,
}: {
  tools: AgentBlockTool[];
  revealOnHover?: boolean;
}) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  return (
    <Popover open={isMenuOpen} onOpenChange={setIsMenuOpen}>
      <PopoverVerticalEllipseTrigger
        isOpen={isMenuOpen}
        aria-label="More actions"
        className={cn(
          "transition-opacity",
          isMenuOpen || !revealOnHover
            ? "opacity-100"
            : "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
        )}
      />
      <PopoverContent align="end" className="p-0">
        <div className="flex flex-col gap-1 p-1">
          {tools.map((tool, i) => (
            <PopoverMenuItem
              key={i}
              icon={tool.icon}
              title={tool.title}
              disabled={tool.disabled}
              onClick={() => {
                tool.onClick();
                setIsMenuOpen(false);
              }}
              leadingIconClassName="-ml-0.5 -mr-1"
            />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
