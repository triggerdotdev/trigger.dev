import { ShieldCheckIcon } from "@heroicons/react/20/solid";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "~/components/primitives/Tooltip";
import { useHasAdminAccess } from "~/hooks/useUser";

export function AdminDebugTooltip({ children }: { children: React.ReactNode }) {
  const hasAdminAccess = useHasAdminAccess();

  if (!hasAdminAccess) {
    return null;
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger>
          <ShieldCheckIcon className="h-5 w-5" />
        </TooltipTrigger>
        <TooltipContent className="flex items-center gap-1">{children}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
