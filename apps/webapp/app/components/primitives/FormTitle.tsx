import { cn } from "~/utils/cn";
import { Header1 } from "./Headers";
import type { IconNames } from "./NamedIcon";
import { NamedIcon } from "./NamedIcon";
import { Paragraph } from "./Paragraph";

export function FormTitle({
  title,
  description,
  LeadingIcon,
  divide = true,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  LeadingIcon?: IconNames;
  divide?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "mb-4 flex flex-col gap-3 pb-4",
        divide ? "border-b border-slate-800" : "",
        className
      )}
    >
      <div className="flex items-center gap-2">
        {LeadingIcon && (
          <NamedIcon
            name={LeadingIcon}
            className={cn("h-7 w-7 shrink-0 justify-start")}
          />
        )}
        <Header1>{title}</Header1>
      </div>
      {description && <Paragraph variant="small">{description}</Paragraph>}
    </div>
  );
}
