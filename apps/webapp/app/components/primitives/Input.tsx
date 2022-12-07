import classNames from "classnames";

const roundedStyles = {
  roundedLeft:
    "rounded-l focus:outline-offset-[0px] focus:outline-blue-500 -mr-1",
  roundedRight:
    "rounded-r focus:outline-offset-[0px] focus:outline-blue-500 -ml-1",
  roundedFull: "rounded focus:outline-offset-[0px] focus:outline-blue-500",
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
      className={`flex grow border border-slate-200 py-2 pl-3 pr-1 text-slate-700 ${classes}`}
    >
      {children}
    </input>
  );
}
