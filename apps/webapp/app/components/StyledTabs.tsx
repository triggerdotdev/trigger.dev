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
      className={"flex space-x-4 border-b border-slate-700"}
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
            ? "border-indigo-500 text-slate-300 outline-none"
            : "border-transparent text-slate-500 hover:border-slate-200 hover:text-slate-200",
          "disabled:text-slate-300 disabled:hover:border-transparent",
          "flex whitespace-nowrap border-b-2 py-2 px-4 text-base font-medium transition"
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
        "flex max-w-fit gap-0.5 rounded-md bg-slate-800 p-1",
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
            ? "rounded bg-indigo-600 text-white shadow outline-none"
            : "rounded text-slate-300 transition hover:bg-slate-700 hover:text-slate-300 hover:shadow-none",
          "flex whitespace-nowrap py-2 px-4 text-xs font-medium"
        )
      }
      {...props}
    >
      {children}
    </HeadlessTab>
  );
}

export function LargeBoxList({
  children,
  className,
  ...props
}: HeadlessTabListProps) {
  return (
    <HeadlessTab.List
      className={classNames("flex max-w-fit gap-2", className)}
      {...props}
    >
      {children}
    </HeadlessTab.List>
  );
}

export function LargeBox({ children, ...props }: HeadlessTabProps) {
  return (
    <HeadlessTab
      className={({ selected }: { selected: boolean }) =>
        classnames(
          selected
            ? "rounded border border-transparent bg-indigo-600 text-white shadow outline-none"
            : "rounded border border-slate-700  text-slate-300 transition hover:bg-slate-800 hover:text-slate-300 hover:shadow-none",
          "flex whitespace-nowrap py-2 px-4 text-base font-medium"
        )
      }
      {...props}
    >
      {children}
    </HeadlessTab>
  );
}
