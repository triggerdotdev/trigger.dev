import { ChevronRightIcon } from "@heroicons/react/24/solid";
import { useNavigate } from "@remix-run/react";
import React, { ReactNode, forwardRef, useState } from "react";
import { cn } from "~/utils/cn";
import { Popover, PopoverContent, PopoverVerticalEllipseTrigger } from "./Popover";
import { InfoIconTooltip } from "./Tooltip";

type TableProps = {
  containerClassName?: string;
  className?: string;
  children: ReactNode;
  fullWidth?: boolean;
};

export const Table = forwardRef<HTMLTableElement, TableProps>(
  ({ className, containerClassName, children, fullWidth }, ref) => {
    return (
      <div
        className={cn(
          "overflow-x-auto whitespace-nowrap border-t border-grid-bright scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600",
          containerClassName,
          fullWidth && "w-full"
        )}
      >
        <table ref={ref} className={cn("w-full", className)}>
          {children}
        </table>
      </div>
    );
  }
);

type TableHeaderProps = {
  className?: string;
  children: ReactNode;
};

export const TableHeader = forwardRef<HTMLTableSectionElement, TableHeaderProps>(
  ({ className, children }, ref) => {
    return (
      <thead
        ref={ref}
        className={cn(
          "sticky top-0 z-10 bg-background-dimmed after:absolute after:bottom-0 after:left-0 after:right-0 after:h-px after:bg-grid-bright",
          className
        )}
      >
        <tr tabIndex={-1}>{children}</tr>
      </thead>
    );
  }
);

type TableBodyProps = {
  className?: string;
  children?: ReactNode;
};

export const TableBody = forwardRef<HTMLTableSectionElement, TableBodyProps>(
  ({ className, children }, ref) => {
    return (
      <tbody ref={ref} className={cn("relative overflow-y-auto", className)}>
        {children}
      </tbody>
    );
  }
);

type TableRowProps = {
  className?: string;
  children: ReactNode;
  disabled?: boolean;
  isSelected?: boolean;
  to?: string;
  onClick?: (event: React.KeyboardEvent | React.MouseEvent) => void;
};

export const TableRow = forwardRef<HTMLTableRowElement, TableRowProps>(
  ({ className, disabled, isSelected, children, to, onClick }, ref) => {
    const navigate = useNavigate();

    const handleNavigation = (event: React.KeyboardEvent | React.MouseEvent) => {
      // Don't trigger navigation if clicking on interactive elements
      if ((event.target as HTMLElement).closest('button, a, [role="button"], [role="menu"]')) {
        return;
      }

      // For mouse events
      if ("button" in event) {
        // Handle middle mouse button click
        if (event.button === 1) {
          return; // Let default behavior handle middle click
        }

        // Handle CMD/CTRL + Click
        if (event.metaKey || event.ctrlKey) {
          if (to) {
            window.open(to, "_blank");
          }
          return;
        }
      }

      // For keyboard events
      if ("key" in event) {
        if (event.key === "Enter") {
          if (event.metaKey || event.ctrlKey) {
            if (to) {
              window.open(to, "_blank");
            }
            return;
          }
        } else {
          return; // Only handle Enter key for keyboard events
        }
      }

      // Default navigation behavior
      if (to) {
        navigate(to);
      } else if (onClick) {
        onClick(event);
      }
    };

    const handleKeyDown = (event: React.KeyboardEvent) => {
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        handleNavigation(event);
      }
    };

    return (
      <tr
        ref={ref}
        role="link"
        tabIndex={disabled ? -1 : 0}
        onClick={handleNavigation}
        onKeyDown={handleKeyDown}
        className={cn(
          "group/table-row relative w-full cursor-pointer outline-none after:absolute after:bottom-0 after:left-3 after:right-0 after:h-px after:bg-grid-dimmed focus-visible:bg-background-bright",
          disabled && "cursor-not-allowed opacity-50",
          isSelected && isSelectedStyle,
          className
        )}
        aria-disabled={disabled}
      >
        {children}
      </tr>
    );
  }
);

type TableCellBasicProps = {
  className?: string;
  alignment?: "left" | "center" | "right";
  children: ReactNode;
  colSpan?: number;
};

type TableHeaderCellProps = TableCellBasicProps & {
  hiddenLabel?: boolean;
  tooltip?: ReactNode;
};

export const TableHeaderCell = forwardRef<HTMLTableCellElement, TableHeaderCellProps>(
  ({ className, alignment = "left", children, colSpan, hiddenLabel = false, tooltip }, ref) => {
    let alignmentClassName = "text-left";
    switch (alignment) {
      case "center":
        alignmentClassName = "text-center";
        break;
      case "right":
        alignmentClassName = "text-right";
        break;
    }

    return (
      <th
        ref={ref}
        scope="col"
        className={cn(
          "px-3 py-2.5 pb-3 align-middle text-sm font-medium text-text-bright",
          alignmentClassName,
          className
        )}
        colSpan={colSpan}
        tabIndex={-1}
      >
        {hiddenLabel ? (
          <span className="sr-only">{children}</span>
        ) : tooltip ? (
          <div className="flex items-center gap-1">
            {children}
            <InfoIconTooltip content={tooltip} contentClassName="normal-case tracking-normal" />
          </div>
        ) : (
          children
        )}
      </th>
    );
  }
);

type TableCellProps = TableCellBasicProps & {
  to?: string;
  onClick?: (event: React.MouseEvent<HTMLButtonElement, MouseEvent>) => void;
  hasAction?: boolean;
  isSticky?: boolean;
  actionClassName?: string;
  rowHoverStyle?: keyof typeof rowHoverStyles;
  isSelected?: boolean;
};

const rowHoverStyles = {
  default:
    "group-hover/table-row:bg-charcoal-800 group-focus-visible/table-row:bg-background-bright group-hover/table-row:before:absolute group-hover/table-row:before:bg-charcoal-750 group-hover/table-row:before:top-[-1px] group-hover/table-row:before:left-0 group-hover/table-row:before:h-px group-hover/table-row:before:w-3 group-hover/table-row:after:absolute group-hover/table-row:after:bg-charcoal-750 group-hover/table-row:after:bottom-0 group-hover/table-row:after:left-0 group-hover/table-row:after:h-px group-hover/table-row:after:w-3",
  dimmed:
    "group-hover/table-row:bg-charcoal-850 group-hover/table-row:before:absolute group-hover/table-row:before:bg-charcoal-800 group-hover/table-row:before:top-[-1px] group-hover/table-row:before:left-0 group-hover/table-row:before:h-px group-hover/table-row:before:w-3 group-hover/table-row:after:absolute group-hover/table-row:after:bg-charcoal-800 group-hover/table-row:after:bottom-0 group-hover/table-row:after:left-0 group-hover/table-row:after:h-px group-hover/table-row:after:w-3",
  bright:
    "group-hover/table-row:bg-charcoal-750 group-hover/table-row:before:absolute group-hover/table-row:before:bg-charcoal-700 group-hover/table-row:before:top-[-1px] group-hover/table-row:before:left-0 group-hover/table-row:before:h-px group-hover/table-row:before:w-3 group-hover/table-row:after:absolute group-hover/table-row:after:bg-charcoal-700 group-hover/table-row:after:bottom-0 group-hover/table-row:after:left-0 group-hover/table-row:after:h-px group-hover/table-row:after:w-3",
};

const stickyStyles =
  "sticky right-0 bg-background-dimmed group-hover/table-row:bg-charcoal-750 w-[--sticky-width] [&:has(.group-hover\\/table-row\\:block)]:w-auto";

const isSelectedStyle = "bg-charcoal-750 group-hover:bg-charcoal-750";

export const TableCell = forwardRef<HTMLTableCellElement, TableCellProps>(
  (
    {
      className,
      actionClassName,
      alignment = "left",
      children,
      colSpan,
      hasAction = false,
      isSticky = false,
      rowHoverStyle = "default",
      isSelected,
    },
    ref
  ) => {
    let alignmentClassName = "text-left";
    switch (alignment) {
      case "center":
        alignmentClassName = "text-center";
        break;
      case "right":
        alignmentClassName = "text-right";
        break;
    }

    return (
      <td
        ref={ref}
        className={cn(
          "text-xs text-charcoal-400",
          hasAction ? "cursor-pointer" : "h-10 min-h-10 px-3 align-middle",
          alignmentClassName,
          actionClassName,
          isSticky && stickyStyles,
          isSelected && isSelectedStyle,
          !isSelected && rowHoverStyles[rowHoverStyle],
          "child:pointer-events-none [&>[role=button]]:pointer-events-auto [&>[role=menu]]:pointer-events-auto [&>a]:pointer-events-auto [&>button]:pointer-events-auto",
          className
        )}
        colSpan={colSpan}
      >
        {children}
      </td>
    );
  }
);

export const TableCellChevron = forwardRef<
  HTMLTableCellElement,
  {
    className?: string;
    to?: string;
    children?: ReactNode;
    isSticky?: boolean;
    onClick?: (event: React.MouseEvent<HTMLButtonElement, MouseEvent>) => void;
  }
>(({ className, to, children, isSticky, onClick }, ref) => {
  return (
    <TableCell
      className={className}
      isSticky={isSticky}
      to={to}
      onClick={onClick}
      ref={ref}
      alignment="right"
    >
      {children}
      <ChevronRightIcon className="size-4 text-text-dimmed transition group-hover:text-text-bright" />
    </TableCell>
  );
});

export const TableCellMenu = forwardRef<
  HTMLTableCellElement,
  {
    className?: string;
    isSticky?: boolean;
    onClick?: (event: React.MouseEvent<HTMLButtonElement, MouseEvent>) => void;
    visibleButtons?: ReactNode;
    hiddenButtons?: ReactNode;
    popoverContent?: ReactNode;
    children?: ReactNode;
    isSelected?: boolean;
  }
>(
  (
    {
      className,
      isSticky,
      onClick,
      visibleButtons,
      hiddenButtons,
      popoverContent,
      children,
      isSelected,
    },
    ref
  ) => {
    const [isOpen, setIsOpen] = useState(false);

    return (
      <TableCell
        className={className}
        isSticky={isSticky}
        onClick={onClick}
        ref={ref}
        alignment="right"
        hasAction={true}
        isSelected={isSelected}
      >
        <div className="relative h-full p-1">
          <div
            className={cn(
              "absolute right-0 top-1/2 mr-1 flex -translate-y-1/2 items-center justify-end gap-0.5 rounded-[0.25rem] bg-background-dimmed p-0.5 group-hover/table-row:bg-background-bright group-hover/table-row:ring-1 group-hover/table-row:ring-grid-bright"
            )}
          >
            {/* Hidden buttons that show on hover */}
            {hiddenButtons && (
              <div className="hidden pr-0.5 group-hover/table-row:block group-hover/table-row:border-r group-hover/table-row:border-grid-dimmed">
                {hiddenButtons}
              </div>
            )}
            {/* Always visible buttons  */}
            {visibleButtons}
            {/* Always visible popover with ellipsis trigger */}
            {popoverContent && (
              <Popover onOpenChange={(open) => setIsOpen(open)}>
                <PopoverVerticalEllipseTrigger
                  isOpen={isOpen}
                  className="duration-0 group-hover/table-row:text-text-bright"
                />
                <PopoverContent
                  className="min-w-[10rem] max-w-[20rem] overflow-y-auto p-0 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600"
                  align="end"
                >
                  <div className="flex flex-col gap-1 p-1">{popoverContent}</div>
                </PopoverContent>
              </Popover>
            )}
            {/* Optionally pass in children to render in a popover */}
            {!visibleButtons && !hiddenButtons && !popoverContent && (
              <Popover onOpenChange={(open) => setIsOpen(open)}>
                <PopoverVerticalEllipseTrigger isOpen={isOpen} />
                <PopoverContent
                  className="w-fit max-w-[10rem] overflow-y-auto p-0 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600"
                  align="end"
                >
                  <div className="flex flex-col gap-1 p-1">{children}</div>
                </PopoverContent>
              </Popover>
            )}
          </div>
        </div>
      </TableCell>
    );
  }
);

type TableBlankRowProps = {
  className?: string;
  colSpan: number;
  children?: ReactNode;
};

export const TableBlankRow = forwardRef<HTMLTableRowElement, TableBlankRowProps>(
  ({ children, colSpan, className }, ref) => {
    return (
      <tr ref={ref}>
        <td colSpan={colSpan} className={cn("py-6 text-center text-sm", className)}>
          {children}
        </td>
      </tr>
    );
  }
);
