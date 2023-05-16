import { cn } from "~/utils/cn";
import { Header1 } from "./Headers";
import type { IconNames } from "./NamedIcon";
import { NamedIcon } from "./NamedIcon";

export function FormTitle({
  children,
  LeadingIcon,
  divide = true,
  className,
}: {
  children: React.ReactNode;
  LeadingIcon?: IconNames;
  divide?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "mb-4 flex items-center gap-2 pb-2",
        divide ? "border-b border-slate-800" : "",
        className
      )}
    >
      {LeadingIcon && (
        <NamedIcon
          name={LeadingIcon}
          className={cn("h-7 w-7 shrink-0 justify-start")}
        />
      )}
      <Header1>{children}</Header1>
    </div>
  );
}
