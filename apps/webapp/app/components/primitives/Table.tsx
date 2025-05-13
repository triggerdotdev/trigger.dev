import { ChevronRightIcon } from "@heroicons/react/24/solid";
import { Link } from "@remix-run/react";
import React, { type ReactNode, forwardRef, useState, useContext, createContext } from "react";
import { cn } from "~/utils/cn";
import { Popover, PopoverContent, PopoverVerticalEllipseTrigger } from "./Popover";
import { InfoIconTooltip } from "./Tooltip";

const variants = {
  bright: {
    header: "bg-background-bright",
    cell: "group-hover/table-row:bg-charcoal-750 group-has-[[tabindex='0']:focus]/table-row:bg-charcoal-750",
    stickyCell: "bg-background-bright group-hover/table-row:bg-charcoal-750",
    menuButton:
      "bg-background-bright group-hover/table-row:bg-charcoal-750 group-hover/table-row:ring-charcoal-600/70 group-has-[[tabindex='0']:focus]/table-row:bg-charcoal-750",
    menuButtonDivider: "group-hover/table-row:border-charcoal-600/70",
    rowSelected: "bg-charcoal-750 group-hover/table-row:bg-charcoal-750",
  },
  dimmed: {
    header: "bg-background-dimmed",
    cell: "group-hover/table-row:bg-charcoal-800 group-has-[[tabindex='0']:focus]/table-row:bg-background-bright",
    stickyCell: "group-hover/table-row:bg-charcoal-800",
    menuButton:
      "bg-background-dimmed group-hover/table-row:bg-charcoal-800 group-hover/table-row:ring-grid-bright group-has-[[tabindex='0']:focus]/table-row:bg-background-bright",
    menuButtonDivider: "group-hover/table-row:border-grid-bright",
    rowSelected: "bg-charcoal-750 group-hover/table-row:bg-charcoal-750",
  },
} as const;

export type TableVariant = keyof typeof variants;

type TableProps = {
  containerClassName?: string;
  className?: string;
  children: ReactNode;
  fullWidth?: boolean;
};

// Add TableContext
const TableContext = createContext<{ variant: TableVariant }>({ variant: "dimmed" });

export const Table = forwardRef<HTMLTableElement, TableProps & { variant?: TableVariant }>(
  ({ className, containerClassName, children, fullWidth, variant = "dimmed" }, ref) => {
    return (
      <TableContext.Provider value={{ variant }}>
        <div
          className={cn(
            "overflow-x-auto whitespace-nowrap border-t scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600",
            containerClassName,
            fullWidth && "w-full"
          )}
        >
          <table ref={ref} className={cn("w-full", className)}>
            {children}
          </table>
        </div>
      </TableContext.Provider>
    );
  }
);

type TableHeaderProps = {
  className?: string;
  children: ReactNode;
};

export const TableHeader = forwardRef<HTMLTableSectionElement, TableHeaderProps>(
  ({ className, children }, ref) => {
    const { variant } = useContext(TableContext);
    return (
      <thead
        ref={ref}
        className={cn(
          "sticky top-0 z-10 after:absolute after:bottom-0 after:left-0 after:right-0 after:h-px after:bg-grid-bright",
          variants[variant].header,
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
  isSelected?: boolean;
};

export const TableRow = forwardRef<HTMLTableRowElement, TableRowProps>(
  ({ className, disabled, isSelected, children }, ref) => {
    const { variant } = useContext(TableContext);
    return (
      <tr
        ref={ref}
        className={cn(
          "group/table-row relative w-full outline-none",
          isSelected && variants[variant].rowSelected,
          !isSelected && "before:absolute after:absolute",
          "focus-visible:bg-background-bright",
          "[&>td:first-child>div]:after:left-3",
          // fills in the small left hand divider lines on hover
          "[&>td:first-child>div]:hover:before:w-3",
          "[&>td:first-child>div]:hover:after:left-0",
          disabled && "opacity-50",
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
  children?: ReactNode;
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
          <div
            className={cn("flex items-center gap-1", {
              "justify-center": alignment === "center",
              "justify-end": alignment === "right",
            })}
          >
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
  rowHoverStyle?: string;
  isSelected?: boolean;
  isTabbableCell?: boolean;
  children?: ReactNode;
};

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
      isSelected,
      isTabbableCell = false,
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
      "flex w-full whitespace-nowrap px-3 py-3 items-center text-xs text-text-dimmed",
      alignment === "left"
        ? "justify-start text-left"
        : alignment === "center"
        ? "justify-center text-center"
        : "justify-end text-right"
    );
    const { variant } = useContext(TableContext);

    return (
      <td
        ref={ref}
        className={cn(
          "h-full p-0",
          isSticky &&
            "[&:has(.group-hover/table-row:block)]:w-auto sticky right-0 bg-background-dimmed",
          isSticky && variants[variant].stickyCell
        )}
        colSpan={colSpan}
      >
        <div
          className={cn(
            "relative",
            "h-[2.625rem]",
            "min-h-[2.625rem]",
            "text-xs",
            "text-charcoal-400",
            "after:absolute",
            "after:bottom-0",
            "after:left-0",
            "after:right-0",
            "after:h-px",
            "after:bg-grid-dimmed",
            "before:absolute",
            "before:top-[-1px]",
            "before:left-0",
            "before:w-0",
            "before:h-px",
            "before:bg-grid-dimmed",
            // "has-[[tabindex='0']:focus]:before:absolute",
            // "has-[[tabindex='0']:focus]:before:-top-px",
            // "has-[[tabindex='0']:focus]:before:left-0",
            // "has-[[tabindex='0']:focus]:before:h-px",
            // "has-[[tabindex='0']:focus]:before:w-3",
            // "has-[[tabindex='0']:focus]:before:bg-grid-dimmed",
            // "has-[[tabindex='0']:focus]:after:absolute",
            // "has-[[tabindex='0']:focus]:after:bottom-0",
            // "has-[[tabindex='0']:focus]:after:left-0",
            // "has-[[tabindex='0']:focus]:after:right-0",
            // "has-[[tabindex='0']:focus]:after:h-px",
            // "has-[[tabindex='0']:focus]:after:bg-grid-dimmed",
            variants[variant].cell,
            to || onClick || hasAction ? "cursor-pointer" : "cursor-default px-3 py-3 align-middle",
            !to && !onClick && alignmentClassName,

            isSelected && variants[variant].rowSelected,
            className
          )}
        >
          {to ? (
            <Link
              to={to}
              className={cn("cursor-pointer focus:outline-none", flexClasses, actionClassName)}
              tabIndex={isTabbableCell ? 0 : -1}
            >
              {children}
            </Link>
          ) : onClick ? (
            <button
              onClick={onClick}
              className={cn("cursor-pointer focus:outline-none", flexClasses, actionClassName)}
              tabIndex={isTabbableCell ? 0 : -1}
            >
              {children}
            </button>
          ) : (
            <>{children}</>
          )}
        </div>
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
  TableCellProps & {
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
    const { variant } = useContext(TableContext);

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
              "absolute right-0 top-1/2 mr-1 flex -translate-y-1/2 items-center justify-end gap-0.5 rounded-[0.25rem] p-0.5 group-hover/table-row:ring-1",
              variants[variant].menuButton
            )}
          >
            {/* Hidden buttons that show on hover */}
            {hiddenButtons && (
              <div
                className={cn(
                  "hidden group-hover/table-row:block",
                  popoverContent && "pr-0.5 group-hover/table-row:border-r",
                  variants[variant].menuButtonDivider
                )}
              >
                <div className={cn("flex items-center gap-x-0.5 divide-x divide-grid-bright")}>
                  {hiddenButtons}
                </div>
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
