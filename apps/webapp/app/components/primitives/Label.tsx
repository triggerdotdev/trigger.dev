import classNames from "classnames";

type LabelProps = React.DetailedHTMLProps<
  React.LabelHTMLAttributes<HTMLLabelElement>,
  HTMLLabelElement
>;

export function Label(props: LabelProps) {
  return (
    <label
      className={classNames("text-sm text-slate-500", props.className)}
      {...props}
    />
  );
}
