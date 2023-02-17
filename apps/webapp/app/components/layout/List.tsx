import classNames from "classnames";

export type ListProps = {
  children: React.ReactNode;
  className?: string;
};

export function List({ children, className }: ListProps) {
  return (
    <div
      className={classNames(
        className,
        "mb-4 bg-slate-800 shadow-md sm:rounded-md"
      )}
    >
      <ul className="divide-y divide-slate-850">{children}</ul>
    </div>
  );
}
