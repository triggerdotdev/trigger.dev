import classNames from "classnames";

const roundedStyles = {
  roundedLeft: "rounded-l -mr-1",
  roundedRight: "rounded-r -ml-1",
  roundedFull: "rounded",
};

type InputProps = React.DetailedHTMLProps<
  React.InputHTMLAttributes<HTMLInputElement>,
  HTMLInputElement
> & {
  roundedEdges?: "roundedLeft" | "roundedRight" | "roundedFull";
};

export function Input({
  children,
  className,
  roundedEdges = "roundedFull",
  ...props
}: InputProps) {
  const classes = classNames(roundedStyles[roundedEdges], className);

  return (
    <input
      {...props}
      className={classNames(
        `flex grow py-2 pl-3 pr-1 text-slate-200 rounded bg-slate-850 group-focus:border-indigo-500 placeholder:text-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500`,
        classes
      )}
    >
      {children}
    </input>
  );
}
