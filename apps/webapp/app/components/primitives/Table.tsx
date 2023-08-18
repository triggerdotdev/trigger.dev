import { ChevronRightIcon, EllipsisVerticalIcon } from "@heroicons/react/24/solid";
import { Link } from "@remix-run/react";
import { ReactNode, forwardRef } from "react";
import { cn } from "~/utils/cn";
import { Badge } from "./Badge";

type TableProps = {
  containerClassName?: string;
  className?: string;
  children: ReactNode;
};

export const Table = forwardRef<HTMLTableElement, TableProps>(
  ({ className, containerClassName, children }, ref) => {
    return (
      <div
        className={cn(
          "overflow-x-auto whitespace-nowrap rounded-md border border-uiBorder scrollbar-thin scrollbar-track-midnight-850 scrollbar-thumb-slate-700",
          containerClassName
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
        className={cn("rounded-t-md", "relative divide-y divide-uiBorder bg-slate-850", className)}
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
      <tbody ref={ref} className={cn("relative divide-y divide-uiBorder", className)}>
        {children}
      </tbody>
    );
  }
);

type TableRowProps = {
  className?: string;
  children: ReactNode;
};

export const TableRow = forwardRef<HTMLTableRowElement, TableRowProps>(
  ({ className, children }, ref) => {
    return (
      <tr ref={ref} className={cn("group w-full", className)}>
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
          "px-4 py-3 align-middle text-xs font-normal uppercase tracking-wider text-dimmed",
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
};

export const TableCell = forwardRef<HTMLTableCellElement, TableCellProps>(
  ({ className, alignment = "left", children, colSpan, to, onClick }, ref) => {
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
          "text-xs text-slate-400 transition group-hover:bg-slate-900",
          to || onClick ? "cursor-pointer" : "px-4 py-3 align-middle",
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

export const TableCellChevron = forwardRef<
  HTMLTableCellElement,
  {
    className?: string;
    to?: string;
    children?: ReactNode;
    onClick?: (event: React.MouseEvent<HTMLButtonElement, MouseEvent>) => void;
  }
>(({ className, to, children, onClick }, ref) => {
  return (
    <TableCell className={className} to={to} onClick={onClick} ref={ref} alignment="right">
      {children}
      <ChevronRightIcon className="h-4 w-4 text-dimmed transition group-hover:text-bright" />
    </TableCell>
  );
});

export const TableCellMenu = forwardRef<
  HTMLTableCellElement,
  {
    className?: string;
    to?: string;
    children?: ReactNode;
    onClick?: (event: React.MouseEvent<HTMLButtonElement, MouseEvent>) => void;
  }
>(({ className, to, children, onClick }, ref) => {
  return (
    <TableCell className={className} to={to} onClick={onClick} ref={ref} alignment="right">
      {children}
      <EllipsisVerticalIcon className="h-4 w-4 text-dimmed transition group-hover:text-bright" />
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
