import { ChevronRightIcon } from "@heroicons/react/24/solid";
import { Link } from "@remix-run/react";
import { ReactNode, forwardRef } from "react";
import { cn } from "~/utils/cn";

type TableProps = {
  className?: string;
  children: ReactNode;
};

export const Table = forwardRef<HTMLTableElement, TableProps>(
  ({ className, children }, ref) => {
    return (
      <div className="overflow-x-auto whitespace-nowrap rounded-md border border-slate-900 scrollbar-thin scrollbar-track-midnight-850 scrollbar-thumb-slate-700">
        <table
          ref={ref}
          className={cn(
            "divide-slate-85 w-full divide-y bg-midnight-850",
            className
          )}
        >
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

export const TableHeader = forwardRef<
  HTMLTableSectionElement,
  TableHeaderProps
>(({ className, children }, ref) => {
  return (
    <thead
      ref={ref}
      className={cn(
        "rounded-t-md",
        "relative divide-y divide-slate-850",
        className
      )}
    >
      {children}
    </thead>
  );
});

type TableBodyProps = {
  className?: string;
  children: ReactNode;
};

export const TableBody = forwardRef<HTMLTableSectionElement, TableBodyProps>(
  ({ className, children }, ref) => {
    return (
      <tbody
        ref={ref}
        className={cn("relative divide-y divide-slate-850", className)}
      >
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
};

type TableHeaderCellProps = TableCellBasicProps & {
  hiddenLabel?: boolean;
};

export const TableHeaderCell = forwardRef<
  HTMLTableCellElement,
  TableHeaderCellProps
>(({ className, alignment = "left", children, hiddenLabel = false }, ref) => {
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
        "px-4 py-3 align-middle text-xs font-semibold uppercase text-slate-400",
        alignmentClassName,
        className
      )}
    >
      {hiddenLabel ? <span className="sr-only">{children}</span> : children}
    </th>
  );
});

type TableCellProps = TableCellBasicProps & {
  to?: string;
};

export const TableCell = forwardRef<HTMLTableCellElement, TableCellProps>(
  ({ className, alignment = "left", children, to }, ref) => {
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
          "text-xs text-slate-400 transition group-hover:bg-slate-850/50",
          to ? "cursor-pointer" : "px-4 py-3 align-middle",
          !to && alignmentClassName,
          className
        )}
      >
        {to ? (
          <Link
            to={to}
            className={cn(
              "flex w-full whitespace-nowrap px-4 py-3 text-xs text-slate-400",
              alignment === "left"
                ? "justify-start text-left"
                : alignment === "center"
                ? "justify-center text-center"
                : "justify-end text-right"
            )}
          >
            {children}
          </Link>
        ) : (
          <>{children}</>
        )}
      </td>
    );
  }
);

export const TableCellChevron = forwardRef<
  HTMLTableCellElement,
  { className?: string; to: string }
>(({ className, to }, ref) => {
  return (
    <TableCell className={className} to={to} ref={ref} alignment="right">
      <ChevronRightIcon className="h-4 w-4 text-slate-700 transition group-hover:text-bright" />
    </TableCell>
  );
});

type TableBlankRowProps = {
  className?: string;
  colSpan: number;
  children: ReactNode;
};

export const TableBlankRow = forwardRef<
  HTMLTableRowElement,
  TableBlankRowProps
>(({ children, colSpan, className }, ref) => {
  return (
    <tr ref={ref}>
      <td
        colSpan={colSpan}
        className={cn("py-6 text-center text-sm", className)}
      >
        {children}
      </td>
    </tr>
  );
});
