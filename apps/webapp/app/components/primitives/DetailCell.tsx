import { cn } from "~/utils/cn";
import { Icon, IconInBox, RenderIcon } from "./Icon";
import { Paragraph } from "./Paragraph";

const variations = {
  small: {
    label: {
      variant: "small" as const,
      className: "m-0 leading-[1.1rem]",
    },
    description: {
      variant: "extra-small" as const,
      className: "m-0",
    },
  },
  base: {
    label: {
      variant: "base" as const,
      className: "m-0 leading-[1.1rem] ",
    },
    description: {
      variant: "small" as const,
      className: "m-0",
    },
  },
};

type DetailCellProps = {
  leadingIcon?: RenderIcon;
  leadingIconClassName?: string;
  trailingIcon?: RenderIcon;
  trailingIconClassName?: string;
  label: string | React.ReactNode;
  description?: string | React.ReactNode;
  className?: string;
  variant?: keyof typeof variations;
  boxClassName?: string;
};

export function DetailCell({
  leadingIcon,
  leadingIconClassName,
  trailingIcon,
  trailingIconClassName,
  label,
  description,
  className,
  variant = "small",
  boxClassName,
}: DetailCellProps) {
  const variation = variations[variant];

  return (
    <div className={cn("group flex h-11 w-full items-center gap-3 rounded-md p-1 pr-3", className)}>
      <IconInBox
        icon={leadingIcon}
        className={cn("flex-none transition group-hover:border-charcoal-750", leadingIconClassName)}
        boxClassName={boxClassName}
      />
      <div className="flex flex-1 flex-col">
        <Paragraph
          variant={variation.label.variant}
          className={cn("flex-1 text-left", variation.label.className)}
        >
          {label}
        </Paragraph>
        {description && (
          <Paragraph
            variant={variation.description.variant}
            className={cn("flex-1 text-left text-text-dimmed", variation.description.className)}
          >
            {description}
          </Paragraph>
        )}
      </div>
      <div className="flex flex-none items-center gap-1">
        <Icon
          icon={trailingIcon}
          className={cn(
            "h-6 w-6 flex-none transition group-hover:border-charcoal-750",
            trailingIconClassName
          )}
        />
      </div>
    </div>
  );
}
