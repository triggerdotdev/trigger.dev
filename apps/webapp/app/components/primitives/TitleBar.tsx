import { type ReactNode } from "react";
import { cn } from "~/utils/cn";
import { Header2 } from "./Headers";
import { TITLE_BAR_CHROME } from "./Tabs";

/**
 * Names the table below it. Bottom rule only — it doubles as the table's top edge, so render the
 * table with `showTopBorder={false}`. Use `TabContainer variant="title"` for the tabbed form.
 */
export function TitleBar({
  title,
  children,
  className,
}: {
  title: ReactNode;
  /** Right-aligned controls. */
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn(TITLE_BAR_CHROME, "items-center justify-between pl-2.5 pr-1.5", className)}>
      <Header2>{title}</Header2>
      {children ? <div className="flex items-center gap-1.5">{children}</div> : null}
    </div>
  );
}
