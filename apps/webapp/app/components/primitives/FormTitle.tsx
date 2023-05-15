import { cn } from "~/utils/cn";
import { Header1 } from "./Headers";
import type { IconNames } from "./NamedIcon";
import { NamedIcon } from "./NamedIcon";

export function FormTitle({
  children,
  LeadingIcon,
}: {
  children: React.ReactNode;
  LeadingIcon?: IconNames;
}) {
  return (
    <div className="mb-4 flex items-center gap-2 border-b border-slate-800 pb-2">
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
