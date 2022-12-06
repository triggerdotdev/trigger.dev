import { Tab as HeadlessTab } from "@headlessui/react";
import classNames from "classnames";
import classnames from "classnames";

type HeadlessTabProps = Parameters<typeof HeadlessTab>[0];
type HeadlessTabListProps = Parameters<typeof HeadlessTab.List>[0];

export function ClassicList({ children, ...props }: HeadlessTabListProps) {
  return (
    <HeadlessTab.List className={"-mb-px flex bg-slate-50"} {...props}>
      {children}
    </HeadlessTab.List>
  );
}

export function Classic({ children, ...props }: HeadlessTabProps) {
  return (
    <HeadlessTab
      className={({ selected }: { selected: boolean }) =>
        classnames(
          selected
            ? "border-t border-slate-200 bg-white text-slate-600"
            : "border-b border-t border-slate-200 bg-slate-50 text-slate-700 hover:border-slate-200 hover:text-slate-800",
          "flex whitespace-nowrap border-r  py-3 px-3 text-xs focus:outline-none"
        )
      }
      {...props}
    >
      {children}
    </HeadlessTab>
  );
}

export function UnderlinedList({ children, ...props }: HeadlessTabListProps) {
  return (
    <HeadlessTab.List
      className={"-mb-px flex space-x-4 border-b border-slate-200"}
      {...props}
    >
      {children}
    </HeadlessTab.List>
  );
}

export function Underlined({ children, ...props }: HeadlessTabProps) {
  return (
    <HeadlessTab
      className={({ selected }: { selected: boolean }) =>
        classnames(
          selected
            ? "border-blue-500 text-slate-900 outline-none"
            : "border-transparent text-slate-800 hover:border-slate-200 hover:text-slate-700",
          "disabled:text-slate-300 disabled:hover:border-transparent",
          "flex whitespace-nowrap border-b-2 py-2 px-4 text-xs font-medium"
        )
      }
      {...props}
    >
      {children}
    </HeadlessTab>
  );
}

export function SegmentedList({
  children,
  className,
  ...props
}: HeadlessTabListProps) {
  return (
    <HeadlessTab.List
      className={classNames(
        "flex ml-8 gap-0.5 max-w-fit bg-slate-200 rounded-md p-0.5 border border-slate-300",
        className
      )}
      {...props}
    >
      {children}
    </HeadlessTab.List>
  );
}

export function Segmented({ children, ...props }: HeadlessTabProps) {
  return (
    <HeadlessTab
      className={({ selected }: { selected: boolean }) =>
        classnames(
          selected
            ? "bg-blue-500 text-white rounded shadow outline-none"
            : "text-slate-800 hover:bg-slate-300 rounded hover:text-slate-700 hover:shadow-none transition",
          "flex whitespace-nowrap py-2 px-4 text-xs font-medium"
        )
      }
      {...props}
    >
      {children}
    </HeadlessTab>
  );
}
