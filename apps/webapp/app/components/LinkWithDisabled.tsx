import { Link } from "@remix-run/react";
import classNames from "classnames";

type Props = Parameters<typeof Link>[0] & {
  disabled?: boolean;
  disabledClassName?: string;
};

export function LinkDisabled({
  disabled = false,
  disabledClassName,
  ...props
}: Props) {
  if (disabled) {
    return (
      <span
        {...props}
        className={classNames(props.className, disabledClassName)}
      >
        {props.children}
      </span>
    );
  } else {
    return <Link {...props}>{props.children}</Link>;
  }
}
