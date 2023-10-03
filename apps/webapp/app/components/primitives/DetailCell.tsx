import { cn } from "~/utils/cn";
import { Icon, IconInBox, RenderIcon } from "./Icon";
import { Paragraph } from "./Paragraph";

type DetailCellProps = {
  leadingIcon?: RenderIcon;
  leadingIconClassName?: string;
  trailingIcon?: RenderIcon;
  trailingIconClassName?: string;
  label: string;
  labelSize?: "small" | "base";
  description?: string;
  className?: string;
};

export function DetailCell({
  leadingIcon,
  leadingIconClassName,
  trailingIcon,
  trailingIconClassName,
  label,
  labelSize = "small",
  description,
  className,
}: DetailCellProps) {
  return (
    <div
      className={cn(
        "group flex h-11 w-full items-center gap-3 rounded-md p-1 pr-3 transition hover:bg-slate-900",
        className
      )}
    >
      <IconInBox
        icon={leadingIcon}
        className={cn("flex-none transition group-hover:border-slate-750", leadingIconClassName)}
      />
      <div className="flex flex-1 flex-col">
        <Paragraph
          variant={labelSize}
          className="m-0 flex-1 text-left leading-[1.1rem] transition group-hover:text-bright"
        >
          {label}
        </Paragraph>
      </div>
      <div className="flex flex-none items-center gap-1">
        <Icon
          icon={trailingIcon}
          className={cn(
            "h-6 w-6 flex-none transition group-hover:border-slate-750",
            trailingIconClassName
          )}
        />
      </div>
    </div>
  );
}
