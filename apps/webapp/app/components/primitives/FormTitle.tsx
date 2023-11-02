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
  LeadingIcon?: IconNames | React.ReactNode;
  divide?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "mb-4 flex flex-col gap-3 pb-4",
        divide ? "border-b border-ui-border" : "",
        className
      )}
    >
      <div className="flex items-center gap-2">
        {LeadingIcon && (
          <div className="shrink-0 justify-start">
            {typeof LeadingIcon === "string" ? (
              <NamedIcon name={LeadingIcon} className={cn("h-7 w-7")} />
            ) : (
              LeadingIcon
            )}
          </div>
        )}
        <Header1>{title}</Header1>
      </div>
      {description && <Paragraph variant="small">{description}</Paragraph>}
    </div>
  );
}
