import { ChevronRightIcon } from "@heroicons/react/24/solid";
import { Link } from "@remix-run/react";
import { ReactNode, forwardRef, useState } from "react";
import { cn } from "~/utils/cn";
import { Popover, PopoverContent, PopoverVerticalEllipseTrigger } from "./Popover";

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
          "overflow-x-auto whitespace-nowrap rounded-md border border-ui-border scrollbar-thin scrollbar-track-midnight-850 scrollbar-thumb-slate-700",
          containerClassName,
          fullWidth && "w-full"
        )}
      >
        <table ref={ref} className={cn("w-full divide-y", className)}>
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
        className={cn("rounded-t-md", "relative divide-y divide-ui-border bg-slate-850", className)}
      >
        {children}
      </thead>
    );
  }
);

type TableBodyProps = {
  className?: string;
  children: ReactNode;
};

export const TableBody = forwardRef<HTMLTableSectionElement, TableBodyProps>(
  ({ className, children }, ref) => {
    return (
      <tbody ref={ref} className={cn("relative divide-y divide-ui-border", className)}>
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
      <tr ref={ref} className={cn(disabled && "opacity-50", "group w-full", className)}>
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
};

export const TableHeaderCell = forwardRef<HTMLTableCellElement, TableHeaderCellProps>(
  ({ className, alignment = "left", children, colSpan, hiddenLabel = false }, ref) => {
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
          "px-4 py-2 align-middle text-xxs font-normal uppercase tracking-wider text-dimmed",
          alignmentClassName,
          className
        )}
        colSpan={colSpan}
      >
        {hiddenLabel ? <span className="sr-only">{children}</span> : children}
      </th>
    );
  }
);

type TableCellProps = TableCellBasicProps & {
  to?: string;
  onClick?: (event: React.MouseEvent<HTMLButtonElement, MouseEvent>) => void;
  hasAction?: boolean;
};

export const TableCell = forwardRef<HTMLTableCellElement, TableCellProps>(
  ({ className, alignment = "left", children, colSpan, to, onClick, hasAction = false }, ref) => {
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
      "flex w-full whitespace-nowrap px-4 py-3 text-xs text-dimmed",
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
          "text-xs text-slate-400",
          to || onClick || hasAction
            ? "cursor-pointer group-hover:bg-slate-900"
            : "px-4 py-3 align-middle",
          !to && !onClick && alignmentClassName,
          className
        )}
        colSpan={colSpan}
      >
        {to ? (
          <Link to={to} className={flexClasses}>
            {children}
          </Link>
        ) : onClick ? (
          <button onClick={onClick} className={flexClasses}>
            {children}
          </button>
        ) : (
          <>{children}</>
        )}
      </td>
    );
  }
);

const stickyStyles =
  "sticky right-0 z-10 w-[2.8rem] min-w-[2.8rem] bg-background before:absolute before:pointer-events-none before:-left-8 before:top-0 before:h-full before:min-w-[2rem] before:bg-gradient-to-r before:from-transparent before:to-background before:content-[''] group-hover:before:to-slate-900";

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
      className={cn(isSticky && stickyStyles, className)}
      to={to}
      onClick={onClick}
      ref={ref}
      alignment="right"
    >
      {children}
      <ChevronRightIcon className="h-4 w-4 text-dimmed transition group-hover:text-bright" />
    </TableCell>
  );
});

export const TableCellMenu = forwardRef<
  HTMLTableCellElement,
  {
    className?: string;
    children?: ReactNode;
    isSticky?: boolean;
    onClick?: (event: React.MouseEvent<HTMLButtonElement, MouseEvent>) => void;
  }
>(({ className, children, isSticky, onClick }, ref) => {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <TableCell
      className={cn(isSticky && stickyStyles, className)}
      onClick={onClick}
      ref={ref}
      alignment="right"
      hasAction={true}
    >
      <Popover onOpenChange={(open) => setIsOpen(open)}>
        <PopoverVerticalEllipseTrigger isOpen={isOpen} />
        <PopoverContent
          className="w-fit max-w-[10rem] overflow-y-auto p-0 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-slate-700"
          align="end"
        >
          <div className="flex flex-col gap-1 p-1">{children}</div>
        </PopoverContent>
      </Popover>
    </TableCell>
  );
});

type TableBlankRowProps = {
  className?: string;
  colSpan: number;
  children: ReactNode;
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
