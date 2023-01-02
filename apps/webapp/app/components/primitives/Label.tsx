import classNames from "classnames";

type LabelProps = React.DetailedHTMLProps<
  React.LabelHTMLAttributes<HTMLLabelElement>,
  HTMLLabelElement
>;

export function Label(props: LabelProps) {
  return (
    <label
      className={classNames(
        "text-sm font-medium text-slate-400",
        props.className
      )}
      {...props}
    />
  );
}
