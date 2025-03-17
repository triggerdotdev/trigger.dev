import React, { type FunctionComponent, createElement } from "react";
import { cn } from "~/utils/cn";

export type RenderIcon = FunctionComponent<{ className?: string }> | React.ReactNode;

export type IconProps = {
  icon?: RenderIcon;
  className?: string;
};

/** Use this icon to either render a passed in React component, or a NamedIcon/CompanyIcon */
export function Icon(props: IconProps) {
  if (!props.icon) return null;

  if (typeof props.icon === "function") {
    const Icon = props.icon;
    return <Icon className={props.className} />;
  }

  if (React.isValidElement(props.icon)) {
    return <>{props.icon}</>;
  }

  if (
    props.icon &&
    typeof props.icon === "object" &&
    ("type" in props.icon || "$$typeof" in props.icon)
  ) {
    return createElement<FunctionComponent<any>>(
      props.icon as any,
      { className: props.className } as any
    );
  }

  console.error("Invalid icon", props);
  return null;
}

export function IconInBox({ boxClassName, ...props }: IconProps & { boxClassName?: string }) {
  return (
    <div
      className={cn(
        "grid h-9 w-9 place-content-center rounded-sm border border-charcoal-750 bg-charcoal-850",
        boxClassName
      )}
    >
      <Icon icon={props.icon} className={cn("h-6 w-6", props.className)} />
    </div>
  );
}
