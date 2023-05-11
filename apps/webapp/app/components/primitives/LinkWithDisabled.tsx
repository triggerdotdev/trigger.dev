import { Link } from "@remix-run/react";
import { cn } from "~/utils/cn";

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
      <span {...props} className={cn(props.className, disabledClassName)}>
        {props.children}
      </span>
    );
  } else {
    return <Link {...props}>{props.children}</Link>;
  }
}
