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
        `flex grow rounded-lg border border-slate-300 bg-slate-50 py-2 pl-3 pr-1 text-slate-700 focus:outline-offset-[0px] focus:outline-blue-500`,
        classes
      )}
    >
      {children}
    </input>
  );
}
