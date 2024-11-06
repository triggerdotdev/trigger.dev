import { ChevronRightIcon } from "@heroicons/react/24/solid";
import { Link } from "@remix-run/react";
import { ReactNode, forwardRef, useState } from "react";
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
        {children}
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
};

export const TableRow = forwardRef<HTMLTableRowElement, TableRowProps>(
  ({ className, disabled, children }, ref) => {
    return (
      <tr
        ref={ref}
        className={cn(
          disabled && "opacity-50",
          "group/table-row relative w-full after:absolute after:bottom-0 after:left-3 after:right-0 after:h-px after:bg-grid-dimmed",
          className
        )}
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
};

const rowHoverStyles = {
  default:
    "group-hover/table-row:bg-charcoal-800 group-hover/table-row:before:absolute group-hover/table-row:before:bg-charcoal-750 group-hover/table-row:before:top-[-1px] group-hover/table-row:before:left-0 group-hover/table-row:before:h-px group-hover/table-row:before:w-3 group-hover/table-row:after:absolute group-hover/table-row:after:bg-charcoal-750 group-hover/table-row:after:bottom-0 group-hover/table-row:after:left-0 group-hover/table-row:after:h-px group-hover/table-row:after:w-3",
  dimmed:
    "group-hover/table-row:bg-charcoal-850 group-hover/table-row:before:absolute group-hover/table-row:before:bg-charcoal-800 group-hover/table-row:before:top-[-1px] group-hover/table-row:before:left-0 group-hover/table-row:before:h-px group-hover/table-row:before:w-3 group-hover/table-row:after:absolute group-hover/table-row:after:bg-charcoal-800 group-hover/table-row:after:bottom-0 group-hover/table-row:after:left-0 group-hover/table-row:after:h-px group-hover/table-row:after:w-3",
  bright:
    "group-hover/table-row:bg-charcoal-750 group-hover/table-row:before:absolute group-hover/table-row:before:bg-charcoal-700 group-hover/table-row:before:top-[-1px] group-hover/table-row:before:left-0 group-hover/table-row:before:h-px group-hover/table-row:before:w-3 group-hover/table-row:after:absolute group-hover/table-row:after:bg-charcoal-700 group-hover/table-row:after:bottom-0 group-hover/table-row:after:left-0 group-hover/table-row:after:h-px group-hover/table-row:after:w-3",
};

const stickyStyles =
  "sticky right-0 bg-background-dimmed group-hover/table-row:bg-charcoal-750 w-[--sticky-width] [&:has(.group-hover\\/table-row\\:block)]:w-auto";

export const TableCell = forwardRef<HTMLTableCellElement, TableCellProps>(
  (
    {
      className,
      actionClassName,
      alignment = "left",
      children,
      colSpan,
      to,
      onClick,
      hasAction = false,
      isSticky = false,
      rowHoverStyle = "default",
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

    const flexClasses = cn(
      "flex w-full whitespace-nowrap px-3 py-3 text-xs text-text-dimmed",
      alignment === "left"
        ? "justify-start text-left"
        : alignment === "center"
        ? "justify-center text-center"
        : "justify-end text-right"
    );

    return (
      <td
        ref={ref}
        className={cn(
          "text-xs text-charcoal-400",
          to || onClick || hasAction ? "cursor-pointer" : "px-3 py-3 align-middle",
          !to && !onClick && alignmentClassName,
          isSticky && stickyStyles,
          rowHoverStyles[rowHoverStyle],
          className
        )}
        colSpan={colSpan}
      >
        {to ? (
          <Link to={to} className={cn("focus-custom", flexClasses, actionClassName)}>
            {children}
          </Link>
        ) : onClick ? (
          <button onClick={onClick} className={cn("focus-custom", flexClasses, actionClassName)}>
            {children}
          </button>
        ) : (
          <>{children}</>
        )}
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
  }
>(
  (
    { className, isSticky, onClick, visibleButtons, hiddenButtons, popoverContent, children },
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
      >
        <div className="relative p-1">
          <div className="absolute right-0 top-1/2 mr-1 flex -translate-y-1/2 items-center justify-end gap-0.5 bg-background-dimmed p-0.5 group-hover/table-row:rounded-[0.25rem] group-hover/table-row:bg-background-bright group-hover/table-row:ring-1 group-hover/table-row:ring-grid-bright">
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
                <PopoverVerticalEllipseTrigger isOpen={isOpen} />
                <PopoverContent
                  className="min-w-[10rem] max-w-[20rem] overflow-y-auto p-0 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600"
                  align="end"
                >
                  <div className="flex flex-col gap-1 p-1">{popoverContent}</div>
                </PopoverContent>
              </Popover>
            )}

            {/*
              Todo: This is support for the legacy TableCell where all buttons were in Popovers.
              Replace all instances of this with the new options above and remove when done.
            */}
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
