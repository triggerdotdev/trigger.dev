import { type AnchorHTMLAttributes } from "react";
import { usePathName } from "~/hooks/usePathName";
import { cn } from "~/utils/cn";
import { LinkButton } from "../primitives/Buttons";
import { type IconNames } from "../primitives/NamedIcon";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../primitives/Tooltip";
import { Icon } from "../primitives/Icon";
import { IconExclamationCircle } from "@tabler/icons-react";

export function SideMenuItem({
  icon,
  iconColor,
  name,
  to,
  hasWarning,
  count,
  target,
  subItem = false,
}: {
  icon?: IconNames | React.ComponentType<any>;
  iconColor?: string;
  name: string;
  to: string;
  hasWarning?: string | boolean;
  count?: number;
  target?: AnchorHTMLAttributes<HTMLAnchorElement>["target"];
  subItem?: boolean;
}) {
  const pathName = usePathName();
  const isActive = pathName === to;

  return (
    <LinkButton
      variant={subItem ? "small-menu-sub-item" : "small-menu-item"}
      fullWidth
      textAlignLeft
      LeadingIcon={icon}
      leadingIconClassName={isActive ? iconColor : "text-text-dimmed"}
      to={to}
      target={target}
      className={cn(
        "text-text-bright group-hover:bg-charcoal-750",
        subItem ? "text-text-dimmed" : "",
        isActive ? "bg-tertiary text-text-bright" : "group-hover:text-text-bright"
      )}
    >
      <div className="flex w-full items-center justify-between">
        {name}
        <div className="flex items-center gap-1">
          {count !== undefined && count > 0 && <MenuCount count={count} />}
          {typeof hasWarning === "string" ? (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger>
                  <Icon icon={IconExclamationCircle} className="h-5 w-5 text-rose-500" />
                </TooltipTrigger>
                <TooltipContent className="flex items-center gap-1 border border-rose-500 bg-rose-500/20 backdrop-blur-xl">
                  {hasWarning}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : (
            hasWarning && <Icon icon={IconExclamationCircle} className="h-5 w-5 text-rose-500" />
          )}
        </div>
      </div>
    </LinkButton>
  );
}

export function MenuCount({ count }: { count: number | string }) {
  return (
    <div className="rounded-full bg-charcoal-900 px-2 py-1 text-xxs text-text-dimmed">{count}</div>
  );
}
