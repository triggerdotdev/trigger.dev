import { ChevronRightIcon } from "@heroicons/react/24/outline";
import { useNavigation } from "@remix-run/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "~/utils/cn";
import { ButtonContent } from "../primitives/Buttons";
import { type RenderIcon } from "../primitives/Icon";
import { Popover, PopoverContent, PopoverTrigger } from "../primitives/Popover";
import { SIDE_MENU_POPOVER_ITEM_ICON, SIDE_MENU_POPOVER_ITEM_LABEL } from "./sideMenuTypes";

/**
 * A menu item whose chevron reveals `children` in a popover to the right, with a
 * short close delay so the pointer can cross the gap.
 */
export function SideMenuPopoverSubMenu({
  title,
  icon,
  leadingIconClassName,
  contentClassName,
  children,
}: {
  title: string;
  icon: RenderIcon;
  leadingIconClassName?: string;
  /** Override the submenu panel's styling, e.g. a narrower width for short entries. */
  contentClassName?: string;
  children: ReactNode;
}) {
  const navigation = useNavigation();
  const [isOpen, setIsOpen] = useState(false);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  // Close the submenu on navigation (the parent popover closes too).
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- This effect intentionally synchronizes local state after an external or lifecycle change.
    setIsOpen(false);
  }, [navigation.location?.pathname]);

  const openNow = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setIsOpen(true);
  };
  const closeSoon = () => {
    // Small delay before closing so the pointer can move onto the content.
    timeoutRef.current = setTimeout(() => setIsOpen(false), 150);
  };

  return (
    <Popover onOpenChange={(open) => setIsOpen(open)} open={isOpen}>
      <div onMouseEnter={openNow} onMouseLeave={closeSoon} className="flex">
        <PopoverTrigger className="w-full justify-between overflow-hidden focus-custom">
          <ButtonContent
            variant="small-menu-item"
            className={cn("hover:bg-background-hover", SIDE_MENU_POPOVER_ITEM_LABEL)}
            LeadingIcon={icon}
            leadingIconClassName={cn(SIDE_MENU_POPOVER_ITEM_ICON, leadingIconClassName)}
            TrailingIcon={ChevronRightIcon}
            trailingIconClassName="text-text-dimmed"
            textAlignLeft
            fullWidth
          >
            {title}
          </ButtonContent>
        </PopoverTrigger>
        <PopoverContent
          className={cn(
            "min-w-64 overflow-y-auto p-0 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control",
            contentClassName
          )}
          align="start"
          style={{ maxHeight: `calc(var(--radix-popover-content-available-height) - 10vh)` }}
          side="right"
          alignOffset={0}
          sideOffset={-4}
          onMouseEnter={openNow}
          onMouseLeave={closeSoon}
        >
          {children}
        </PopoverContent>
      </div>
    </Popover>
  );
}
