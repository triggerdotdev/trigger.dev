import { IconNamesOrString, NamedIcon } from "./NamedIcon";
import { cn } from "~/utils/cn";

export type RenderIcon = IconNamesOrString | React.ComponentType<any>;

type IconProps = {
  icon?: RenderIcon;
  className?: string;
};

/** Use this icon to either render a passed in React component, or a NamedIcon/CompanyIcon */
export function Icon(props: IconProps) {
  if (typeof props.icon === "string") {
    return <NamedIcon name={props.icon} className={props.className ?? ""} fallback={<></>} />;
  }

  const Icon = props.icon;

  if (!Icon) {
    return <></>;
  }

  return <Icon className={props.className} />;
}

export function IconInBox({ boxClassName, ...props }: IconProps & { boxClassName?: string }) {
  return (
    <div
      className={cn(
        "grid h-9 w-9 place-content-center rounded-sm border border-slate-750 bg-slate-850",
        boxClassName
      )}
    >
      <Icon icon={props.icon} className={cn("h-6 w-6", props.className)} />
    </div>
  );
}
