import { IconCircleDotted } from "@tabler/icons-react";
import { useState, type ReactNode } from "react";
import { Popover, PopoverArrowTrigger, PopoverContent } from "./Popover";

export function MarkAsDropdown({
  label,
  disabled,
  open: controlledOpen,
  onOpenChange,
  children,
}: {
  label: string;
  disabled?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: (close: () => void) => ReactNode;
}) {
  const [innerOpen, setInnerOpen] = useState(false);
  const open = controlledOpen ?? innerOpen;
  const setOpen = onOpenChange ?? setInnerOpen;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverArrowTrigger variant="primary" disabled={disabled} className="items-center">
        <IconCircleDotted className="-ml-1 mr-1 size-3.5 text-white" />
        {label}
      </PopoverArrowTrigger>
      <PopoverContent className="inline-flex min-w-0! flex-col p-1" align="end">
        {children(() => setOpen(false))}
      </PopoverContent>
    </Popover>
  );
}
