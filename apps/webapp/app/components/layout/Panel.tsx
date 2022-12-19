import classNames from "classnames";

export type PanelProps = {
  children: React.ReactNode;
  className?: string;
};

export function Panel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={classNames(
        "bg-slate-800 shadow-md rounded-md pl-5 pt-3 pb-1 pr-3",
        {
          className,
        }
      )}
    >
      {children}
    </div>
  );
}
