import classNames from "classnames";

type SelectProps = React.DetailedHTMLProps<
  React.SelectHTMLAttributes<HTMLSelectElement>,
  HTMLSelectElement
>;

const defaultClasses =
  "block rounded bg-slate-700 text-slate-200 shadow-md border-none py-2 pl-4 pr-9 text-sm hover:cursor-pointer hover:bg-slate-700/50 focus:border-none focus:outline-none focus:ring-0 transition";

export function Select({ children, className, ...props }: SelectProps) {
  return (
    <select className={classNames(defaultClasses, className)} {...props}>
      {children}
    </select>
  );
}
